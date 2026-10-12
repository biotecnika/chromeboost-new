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
  if (msg && typeof msg.type === "string" && DESK_LOCK_MSGS.has(msg.type)) return; // handled by the desk-lock listener below
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

// ============================================================
// Desk Lock — GATE PASS presence engine (v2.6.0)
// Polls presence-state for the signed-in work email and writes cb_presence,
// which desk-lock.js renders. Server-gated: non-pilot machines get "disabled".
// Fail posture: fail-CLOSED while WorkLens is reachable (stays locked when the
// gate is uncertain), fail-OPEN only when WorkLens itself is unreachable.
// Purely additive — does not touch the monitoring above.
// ============================================================
const WLDL = { POLL_MIN: 0.5, RESUME_SUPPRESS_MS: 90000 };
const DESK_LOCK_MSGS = new Set([
  "RESUME", "RECHECK", "OTP_REQUEST", "OTP_VERIFY", "ADMIN_REQUEST", "ADMIN_VERIFY", "END_BORROW", "GET_STATE"
]);

let _wlEmail = null;
async function getEmail() {
  if (_wlEmail) return _wlEmail;
  try {
    const stored = (await chrome.storage.local.get("cb_email")).cb_email;
    if (stored && stored.includes("@")) { _wlEmail = stored; return _wlEmail; }
  } catch (_) {}
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, async (info) => {
        let email = null;
        if (!chrome.runtime.lastError && info && info.email) email = info.email.toLowerCase().trim();
        if (!email) { const id = await getIdentifier(); if (id && id !== "unknown") email = id + "@biotecnika.org"; }
        _wlEmail = email;
        if (email) { try { await chrome.storage.local.set({ cb_email: email }); } catch (_) {} }
        resolve(email);
      });
    } catch (_) { resolve(null); }
  });
}

const wlGet = (k, d) => new Promise(r => chrome.storage.local.get(k, o => r(o[k] ?? d)));
const wlSet = (o) => new Promise(r => chrome.storage.local.set(o, r));

async function wlFetchPresence(email) {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/presence-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(9000)
    });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    const reachable = !!(body && typeof body === "object" && ("ok" in body));
    return { reachable, body };
  } catch (_) { return { reachable: false, body: null }; }
}

async function wlOtp(action, body) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/otp-desk-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(12000)
  });
  return r.json();
}

async function wlEndBorrow(borrow, reason) {
  try { if (borrow && borrow.access_event_id) await wlOtp("end", { access_event_id: borrow.access_event_id, ended_reason: reason }); } catch (_) {}
  await wlSet({ cb_desk_borrow: null });
}

async function wlPollPresence() {
  const email = await getEmail();
  if (!email) { await wlSet({ cb_presence: { ok: false, state: "no_email", updated_at: new Date().toISOString() } }); return; }
  const now = Date.now();
  const { reachable, body } = await wlFetchPresence(email);
  let display;
  if (!reachable) display = { ok: false, state: "wl_down", worklens_reachable: false, email, updated_at: new Date().toISOString() };
  else if (body.lock_disabled) display = { ...body, state: "disabled", worklens_reachable: true, email, updated_at: new Date().toISOString() };
  else if (body.ok === false && body.reason === "gate_unreachable") display = { ...body, state: "hold", worklens_reachable: true, email, updated_at: new Date().toISOString() };
  else display = { ...body, worklens_reachable: true, email, updated_at: new Date().toISOString() };

  // v2.10.1: trust a borrow the SERVER already knows about (desk_access_events), not just one
  // this extension instance created itself. Fixes a double-OTP bug: if the colleague unlocked
  // via the Windows agent's OTP flow, that write lands in the same shared table, and this
  // extension's own lock would otherwise have no idea and prompt for a second code.
  let borrow = await wlGet("cb_desk_borrow", null);
  if (!borrow && body && body.borrow && body.borrow.session_expires_at) {
    borrow = {
      type: body.borrow.access_type === "admin_override" ? "admin" : "otp",
      accessor: body.borrow.accessor_email,
      access_event_id: body.borrow.access_event_id,
      session_expires_at: body.borrow.session_expires_at,
      owner_email: email,
    };
    await wlSet({ cb_desk_borrow: borrow });
  }
  if (borrow && borrow.session_expires_at) {
    const capMs = new Date(borrow.session_expires_at).getTime();
    const ownerBack = display && display.in_office === true;
    if (borrow.type === "otp" && ownerBack) await wlEndBorrow(borrow, "owner_returned");
    else if (now >= capMs) await wlEndBorrow(borrow, "cap_expired");
    else {
      display = { ...display, state: "borrowed", borrow_type: borrow.type, borrow_accessor: borrow.accessor,
        borrow_remaining_sec: Math.max(0, Math.floor((capMs - now) / 1000)) };
      await wlSet({ cb_presence: display }); return;
    }
  }
  const suppressUntil = await wlGet("cb_resume_suppress_until", 0);
  if (now < suppressUntil && (display.state === "returned_not_resumed" || display.state === "away_at_desk")) {
    display = { ...display, state: "working", _suppressed: true };
  }
  await wlSet({ cb_presence: display });
}

// ── LinkedIn feed access (v2.8.1) ──────────────────────────────────────
// Server decides (team-based, from CrewCharm roster in WorkLens). Result is
// cached in storage for linkedin-feed-block.js. Any failure => keep last
// known value; no value ever stored => feed stays blocked (fail-closed).
async function wlPollLinkedin() {
  try {
    const email = await getEmail();
    if (!email) return;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/linkedin-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(9000)
    });
    const b = await r.json();
    if (b && b.ok === true) await wlSet({ cb_linkedin_access: { allowed: b.allowed === true, team: b.team || null, checked_at: Date.now() } });
  } catch (_) {}
}
chrome.alarms.create("wl_linkedin", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "wl_linkedin") wlPollLinkedin(); });
wlPollLinkedin();

// ── Spreadsheet DLP (v2.10.0) ────────────────────────────────────────────────
// Server decides exemption (team/user, from CrewCharm roster) + the global
// enforce kill switch (observe-first rollout). Cached in storage for both this
// file's download interception and content.js's upload interception.
// Fail-closed: no cached value, or any poll failure, => treated as not exempt
// (restricted). `enforce` defaults to false (don't block) until a successful
// poll says otherwise — a brand-new feature should never block on a guess.
const DLP_BLOCKED_EXT = new Set(["csv", "xls", "xlsx", "xlsm"]);

function dlpBasename(pathOrUrl) {
  try {
    const u = new URL(pathOrUrl, "https://x/");
    const last = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (last) return last;
  } catch (_) {}
  return String(pathOrUrl || "").split(/[\\/]/).pop() || "download";
}
function dlpExtOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || "").trim());
  return m ? m[1].toLowerCase() : "";
}

async function wlPollDlp() {
  try {
    const email = await getEmail();
    if (!email) return;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/dlp-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(9000)
    });
    const b = await r.json();
    if (b && b.ok === true) {
      await wlSet({ cb_dlp_access: { exempt: b.exempt === true, enforce: b.enforce === true, team: b.team || null, checked_at: Date.now() } });
    }
  } catch (_) { /* keep last known cached value; fail-closed default lives at the read site */ }
}
chrome.alarms.create("wl_dlp", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "wl_dlp") wlPollDlp(); });
wlPollDlp();

function injectDlpBlockOverlay(filename) {
  if (document.getElementById("__cb_dlp_overlay")) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const overlay = document.createElement("div");
  overlay.id = "__cb_dlp_overlay";
  overlay.style.cssText = `position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;background:rgba(0,0,0,0.8)!important;z-index:2147483647!important;display:flex!important;align-items:center!important;justify-content:center!important;font-family:'Segoe UI',system-ui,sans-serif!important;`;
  overlay.innerHTML = `
    <div style="background:#1a1f2e;border:2px solid #ef4444;border-radius:16px;padding:36px 40px;max-width:440px;width:90%;text-align:center;box-shadow:0 25px 60px rgba(0,0,0,0.8);">
      <div style="width:60px;height:60px;background:#7f1d1d;border:2px solid #ef4444;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:26px;">🚫</div>
      <span style="background:#ef4444;color:#fff;font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 12px;border-radius:20px;display:inline-block;margin-bottom:14px;">Download Blocked</span>
      <h2 style="color:#f0f6fc;font-size:19px;font-weight:700;margin:0 0 10px;">Spreadsheet download restricted</h2>
      <p style="color:#9aa3be;font-size:13px;line-height:1.6;margin:0 0 8px;">${esc(filename)} wasn't downloaded. CSV/Excel file downloads are restricted by company policy.</p>
      <p style="color:#6b7280;font-size:12px;line-height:1.5;margin:0 0 22px;">Contact IT if you need an exception.</p>
      <button id="__cb_dlp_btn" style="background:#ef4444;color:#fff;border:none;padding:11px 28px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;width:100%;">Dismiss</button>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("__cb_dlp_btn").addEventListener("click", () => overlay.remove());
  setTimeout(() => { try { overlay.remove(); } catch (_) {} }, 10000);
}

chrome.downloads.onCreated.addListener(async (item) => {
  try {
    const name = item.filename ? dlpBasename(item.filename) : dlpBasename(item.url || "");
    const ext = dlpExtOf(name) || dlpExtOf(item.url || "");
    if (!DLP_BLOCKED_EXT.has(ext)) return;
    const dlp = await wlGet("cb_dlp_access", { exempt: false, enforce: false, team: null });
    const d = domain(item.finalUrl || item.url || item.referrer || "");
    const willBlock = dlp.enforce === true && dlp.exempt !== true;
    if (willBlock) {
      try { await chrome.downloads.cancel(item.id); } catch (_) {}
      try { await chrome.downloads.erase({ id: item.id }); } catch (_) {}
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && isInjectableUrl(tab.url)) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectDlpBlockOverlay, args: [name] });
        }
      } catch (_) {}
    }
    await push("spreadsheet_blocked", {
      direction: "download", filename: name, ext, domain: d,
      blocked: willBlock, would_block: dlp.exempt !== true, team: dlp.team || null,
    });
    if (willBlock) await flush();
  } catch (_) {}
});

// ── Meeting detection (v2.9.0) ───────────────────────────────────────────────
// A video call looks exactly like "idle" to keyboard/mouse detection. We report
// "in a meeting" when a known meeting tab is open AND it is playing (or recently
// played) audio. Only the platform name is sent - never the tab URL/title/people.
//   Meet:  meeting-room URL (abc-defg-hij) + audio   | Zoom web client + audio
//   Teams/Webex/Whereby/Slack huddle tabs: audio is the signal.
const WLMT = {
  POLL_MIN: 0.5,                 // 30 s (MV3 alarm floor)
  AUDIO_GRACE_MS: 10 * 60 * 1000, // quiet stretch inside a call still counts
  PLATFORMS: [
    { p: "meet",  re: /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#]|$)/i, needRoom: true },
    { p: "zoom",  re: /^https:\/\/[\w.-]*zoom\.us\/(?:wc\/|j\/|myhome)/i },
    { p: "teams", re: /^https:\/\/teams\.(?:microsoft|live)\.com\//i },
    { p: "webex", re: /^https:\/\/[\w.-]*webex\.com\/(?:meet|wbxmjs|webappng)/i },
    { p: "whereby", re: /^https:\/\/whereby\.com\//i },
    { p: "slack", re: /^https:\/\/app\.slack\.com\/huddle/i },
  ],
};
function wlMeetingPlatform(url) {
  for (const x of WLMT.PLATFORMS) if (x.re.test(url || "")) return x;
  return null;
}
chrome.tabs.onUpdated.addListener((tabId, ch, tab) => {
  if (ch.audible === true && wlMeetingPlatform(tab && tab.url)) {
    wlGet("cb_meet_audio", {}).then(m => { m[tabId] = Date.now(); wlSet({ cb_meet_audio: m }); });
  }
});
let _wlInMeeting = false;
async function wlCheckMeeting() {
  try {
    const tabs = await chrome.tabs.query({});
    const audio = await wlGet("cb_meet_audio", {});
    const now = Date.now();
    let hit = null;
    for (const t of tabs) {
      const pl = wlMeetingPlatform(t.url);
      if (!pl) continue;
      if (t.audible) { audio[t.id] = now; }
      const recentAudio = audio[t.id] && (now - audio[t.id]) < WLMT.AUDIO_GRACE_MS;
      if (recentAudio) { hit = pl.p; break; }
    }
    // forget tabs that no longer exist
    const live = new Set(tabs.map(t => String(t.id)));
    for (const k of Object.keys(audio)) if (!live.has(k)) delete audio[k];
    await wlSet({ cb_meet_audio: audio });
    if (hit) {
      await push("meeting_state", { in_meeting: true, platform: hit });
      _wlInMeeting = true;
    } else if (_wlInMeeting) {
      await push("meeting_state", { in_meeting: false });
      _wlInMeeting = false;
    }
  } catch (_) {}
}
chrome.alarms.create("wl_meeting", { periodInMinutes: WLMT.POLL_MIN });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "wl_meeting") wlCheckMeeting(); });

chrome.alarms.create("wl_presence", { periodInMinutes: WLDL.POLL_MIN });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "wl_presence") wlPollPresence(); });
wlPollPresence();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !DESK_LOCK_MSGS.has(msg.type)) return; // not a desk-lock message
  (async () => {
    try {
      const email = await getEmail();
      const cn = email ? email.split("@")[0].toLowerCase() : "";
      if (msg.type === "GET_STATE") sendResponse({ presence: await wlGet("cb_presence", null), email });
      else if (msg.type === "RECHECK") { await wlPollPresence(); sendResponse({ ok: true, presence: await wlGet("cb_presence", null) }); }
      else if (msg.type === "RESUME") {
        const p = await wlGet("cb_presence", null);
        if (p && p.resume_allowed) {
          await push("desk_resume", { source: "browser" });
          await flush();
          await wlSet({ cb_resume_suppress_until: Date.now() + WLDL.RESUME_SUPPRESS_MS });
          await wlPollPresence();
          sendResponse({ ok: true });
        } else sendResponse({ ok: false, reason: "not_scanned_in" });
      }
      else if (msg.type === "OTP_REQUEST") sendResponse(await wlOtp("request", { email: String(msg.email || "").toLowerCase(), computer_name: cn, owner_email: email }));
      else if (msg.type === "OTP_VERIFY") {
        const res = await wlOtp("verify", { email: String(msg.email || "").toLowerCase(), code: String(msg.code || ""), computer_name: cn, owner_email: email });
        if (res && res.ok && res.access_event_id) { await wlSet({ cb_desk_borrow: { type: "otp", accessor: String(msg.email).toLowerCase(), access_event_id: res.access_event_id, session_expires_at: res.session_expires_at, owner_email: email } }); await wlPollPresence(); }
        sendResponse(res);
      }
      else if (msg.type === "ADMIN_REQUEST") sendResponse(await wlOtp("admin_request", { owner_email: email, computer_name: cn }));
      else if (msg.type === "ADMIN_VERIFY") {
        const res = await wlOtp("admin_verify", { code: String(msg.code || ""), owner_email: email, computer_name: cn });
        if (res && res.ok && res.access_event_id) { await wlSet({ cb_desk_borrow: { type: "admin", accessor: "shekhar@biotecnika.org", access_event_id: res.access_event_id, session_expires_at: res.session_expires_at, owner_email: email } }); await wlPollPresence(); }
        sendResponse(res);
      }
      else if (msg.type === "END_BORROW") { const b = await wlGet("cb_desk_borrow", null); if (b) await wlEndBorrow(b, "manual"); await wlPollPresence(); sendResponse({ ok: true }); }
      else sendResponse({ ok: false, reason: "unknown" });
    } catch (e) { sendResponse({ ok: false, reason: "error", detail: String(e) }); }
  })();
  return true;
});

// ============================================================
// BioCRM — "My Scoreboard" widget feed (v2.7.0)
// Identity-bound: the rep is authenticated by their own BioCRM session JWT
// (captured from crm.biotecnika.org localStorage by crm-session.js). No shared
// secret, no email param — the my_scorecard RPC returns ONLY the caller's own
// numbers via auth.uid(). The background refreshes the token so the widget stays
// always-on even when the CRM tab is closed. Only Sales / Achievers / CRM reps
// get visible:true. Additive — independent of the monitoring + desk-lock code.
// ============================================================
const BIOCRM_URL = "https://dozhxqakzqhhoizgzyxb.supabase.co";
const BIOCRM_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvemh4cWFrenFoaG9pemd6eXhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY2MDg3MzIsImV4cCI6MjA3MjE4NDczMn0.wYL70GT_3mI11VZJCKY2sB4ezqwHn3deHb8lYgRXIj4";
const SCORECARD_POLL_MIN = 2;

async function wlRefreshCrm(session) {
  if (!session || !session.refresh_token) return null;
  try {
    const r = await fetch(`${BIOCRM_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: BIOCRM_ANON_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
      signal: AbortSignal.timeout(9000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.access_token) return null;
    const next = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || session.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600)
    };
    await wlSet({ cb_crm_session: next });
    return next;
  } catch (_) { return null; }
}

async function wlScorecardFetch(accessToken) {
  return fetch(`${BIOCRM_URL}/rest/v1/rpc/my_scorecard`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: BIOCRM_ANON_KEY, Authorization: `Bearer ${accessToken}` },
    body: "{}",
    signal: AbortSignal.timeout(9000)
  });
}

async function wlPollScorecard() {
  let session = await wlGet("cb_crm_session", null);
  if (!session || !session.access_token) {
    await wlSet({ cb_scorecard: { visible: false, _reason: "no_crm_session", fetched_at: new Date().toISOString() } });
    return;
  }
  // Proactive refresh when within 2 min of expiry.
  if (session.expires_at && (session.expires_at * 1000 - Date.now() < 120000)) {
    session = (await wlRefreshCrm(session)) || session;
  }
  try {
    let r = await wlScorecardFetch(session.access_token);
    if (r.status === 401) {
      const ns = await wlRefreshCrm(session);
      if (ns) r = await wlScorecardFetch(ns.access_token);
    }
    let body = null; try { body = await r.json(); } catch { body = null; }
    if (body && typeof body === "object" && "visible" in body) {
      await wlSet({ cb_scorecard: { ...body, fetched_at: new Date().toISOString() } });
    } else {
      const prev = await wlGet("cb_scorecard", null);
      if (prev) await wlSet({ cb_scorecard: { ...prev, _stale: true, fetched_at: new Date().toISOString() } });
    }
  } catch (_) {
    const prev = await wlGet("cb_scorecard", null);
    if (prev) await wlSet({ cb_scorecard: { ...prev, _stale: true, fetched_at: new Date().toISOString() } });
  }
}

chrome.alarms.create("wl_scorecard", { periodInMinutes: SCORECARD_POLL_MIN });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "wl_scorecard") wlPollScorecard(); });
wlPollScorecard();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "CRM_SESSION") {
    (async () => {
      if (msg.session && msg.session.access_token) {
        await wlSet({ cb_crm_session: {
          access_token: msg.session.access_token,
          refresh_token: msg.session.refresh_token || null,
          expires_at: msg.session.expires_at || null
        } });
      } else {
        await wlSet({ cb_crm_session: null });
      }
      await wlPollScorecard();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "SCORECARD_REFRESH") {
    (async () => { await wlPollScorecard(); sendResponse({ ok: true, scorecard: await wlGet("cb_scorecard", null) }); })();
    return true;
  }
});
