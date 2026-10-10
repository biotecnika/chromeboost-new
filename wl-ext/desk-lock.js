// ============================================================
// WorkLens — Desk Lock content script (fleet, v2.6.0)
// Renders the GATE PASS presence lock from cb_presence (written by the
// background presence poll). Gate-gated Resume, colleague OTP borrow, and a
// hidden super-admin override. Server-gated: when presence-state returns
// "disabled" (kill switch / not a pilot machine), nothing is shown.
// ============================================================
(function () {
  "use strict";
  const OV = "__wl_desk_lock";
  const LOCKED = ["out", "returned_not_resumed", "away_at_desk", "hold"];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const send = (m) => new Promise(res => { try { chrome.runtime.sendMessage(m, r => { void chrome.runtime.lastError; res(r); }); } catch { res(null); } });
  const getPresence = () => new Promise(res => { try { chrome.storage.local.get("cb_presence", o => res(o.cb_presence || null)); } catch { res(null); } });

  const COPY = {
    out:                  { title: "Currently out of office", body: "This desk is locked because the gate shows you’ve stepped out. Scan in at the gate to resume work.", resume: false, icon: "🚪" },
    returned_not_resumed: { title: "Welcome back", body: "You’re scanned in. Tap Resume (or just start working) to continue.", resume: true, icon: "👋" },
    away_at_desk:         { title: "Away from desk", body: "No activity for a few minutes. Tap Resume or move the mouse to continue.", resume: true, icon: "💤" },
    hold:                 { title: "Confirming your status", body: "We can’t confirm your gate status right now, so the desk stays locked. Scan in at the gate, tap Re-check, or ask the administrator for an override.", resume: false, icon: "⏳" },
  };

  let mo = null;
  let _rendered = null;
  let clockTimer = null;

  // Away-from-desk (idle) screen is served from a hosted page so its design can change
  // server-side with no extension release. All other lock states still render inline below.
  const IFRAME_ORIGIN = "https://gatepass.biotecnika.org";
  const IFRAME_URL = IFRAME_ORIGIN + "/pause.html";
  let _awayPayload = null;
  let _frameReady = false, _frameFailUntil = 0, _frameTimer = null; // offline fallback for the hosted away screen
  let _iframeMsgBound = false;

  function ensureStyle() {
    if (document.getElementById(OV + "_s")) return;
    const st = document.createElement("style");
    st.id = OV + "_s";
    st.textContent = `
      #${OV}{position:fixed!important;inset:0!important;z-index:2147483646!important;background:linear-gradient(160deg,#0b1020,#111a33)!important;
        display:flex!important;align-items:center!important;justify-content:center!important;font-family:'Segoe UI',system-ui,-apple-system,sans-serif!important;}
      #${OV} *{box-sizing:border-box;}
      #${OV} .wl-card{width:min(460px,92vw);max-height:92vh;overflow:auto;background:#121a2e;border:1px solid #27324d;border-radius:18px;padding:38px 34px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.6);}
      #${OV} .wl-ic{width:64px;height:64px;border-radius:50%;background:#1b2743;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:29px;}
      #${OV} h1{color:#f0f6fc;font-size:22px;font-weight:700;margin:0 0 10px;}
      #${OV} p{color:#9aa6c2;font-size:14px;line-height:1.6;margin:0 0 22px;}
      #${OV} .wl-clock{color:#5e6b8c;font-size:13px;margin:0 0 18px;font-variant-numeric:tabular-nums;}
      #${OV} button{font-family:inherit;cursor:pointer;border:none;border-radius:10px;font-weight:600;}
      #${OV} .wl-primary{background:#3b82f6;color:#fff;padding:13px 22px;font-size:15px;width:100%;}
      #${OV} .wl-primary:disabled{background:#2a3350;color:#6b7694;cursor:not-allowed;}
      #${OV} .wl-link{display:block;width:100%;background:transparent;color:#7f90b5;font-size:12.5px;margin-top:14px;text-decoration:underline;}
      #${OV} .wl-else{margin-top:18px;padding-top:16px;border-top:1px solid #27324d;}
      #${OV} .wl-else .wl-link{margin-top:0;color:#9aa6c2;}
      #${OV} .wl-note{color:#f59e0b;font-size:12.5px;margin-top:10px;min-height:15px;}
      #${OV} .wl-sec{margin-top:16px;border-top:1px solid #27324d;padding-top:16px;text-align:left;}
      #${OV} .wl-sec label{color:#9aa6c2;font-size:12px;display:block;margin-bottom:6px;}
      #${OV} .wl-sec input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #30406a;background:#0d1426;color:#e6ecfb;font-size:15px;margin-bottom:10px;}
      #${OV} .wl-sec .wl-primary{padding:11px;font-size:14px;}
      #${OV} .wl-admin-ttl{color:#f59e0b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;}
      #${OV}_banner .wl-banner{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#14532d;border:1px solid #22c55e;color:#dcffe6;
        padding:10px 16px;border-radius:999px;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;display:flex;gap:12px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.4);}
      #${OV}_banner .wl-banner.admin{background:#422006;border-color:#f59e0b;color:#ffedcc;}
      #${OV}_banner .wl-banner button{background:#064e26;color:#bbf7d0;border:1px solid #22c55e;padding:5px 10px;font-size:12px;border-radius:999px;cursor:pointer;}`;
    (document.head || document.documentElement).appendChild(st);
  }

  function removeOverlay() {
    const o = document.getElementById(OV); if (o) o.remove();
    const b = document.getElementById(OV + "_banner"); if (b) b.remove();
    if (mo) { mo.disconnect(); mo = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    _rendered = null;
  }

  function fmt(sec) { sec = Math.max(0, sec | 0); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, "0")}`; }

  function showBorrow(p) {
    const full = document.getElementById(OV); if (full) full.remove();
    ensureStyle();
    let b = document.getElementById(OV + "_banner");
    const admin = p.borrow_type === "admin";
    if (!b) {
      b = document.createElement("div");
      b.id = OV + "_banner";
      b.innerHTML = `<div class="wl-banner${admin ? " admin" : ""}"><span id="__wl_btxt"></span><button id="__wl_endb">${admin ? "Lock now" : "Done"}</button></div>`;
      document.documentElement.appendChild(b);
      const btn = document.getElementById("__wl_endb");
      if (btn) btn.onclick = async () => { await send({ type: "END_BORROW" }); evaluate(); };
    }
    const t = document.getElementById("__wl_btxt");
    if (t) t.innerHTML = admin
      ? `Admin override active — ${fmt(p.borrow_remaining_sec)} left`
      : `Desk borrowed by <b>${esc(p.borrow_accessor || "colleague")}</b> — ${fmt(p.borrow_remaining_sec)} left`;
    _rendered = "borrowed";
  }

  // Build the state payload the hosted away-screen needs.
  function awayStatePayload(p) {
    const payload = { type: "WL_LOCK_STATE" };
    const t = p && p.last_activity_ts ? Date.parse(p.last_activity_ts) : NaN;
    if (!isNaN(t)) payload.awaySince = t;
    else if (p && typeof p.idle_seconds === "number") payload.idleSeconds = p.idle_seconds;
    const comp = (p && Array.isArray(p.computer_names) && p.computer_names.length)
      ? p.computer_names[0] : ((p && p.computer_name) || "");
    if (comp) payload.computer = comp;
    return payload;
  }

  function bindIframeMessages() {
    if (_iframeMsgBound) return;
    _iframeMsgBound = true;
    window.addEventListener("message", (ev) => {
      if (ev.origin !== IFRAME_ORIGIN) return;
      const d = ev.data || {};
      if (d.type === "WL_LOCK_READY") {
        _frameReady = true; if (_frameTimer) { clearTimeout(_frameTimer); _frameTimer = null; }
        const fr = document.getElementById(OV + "_frame");
        if (fr && fr.contentWindow && _awayPayload) {
          try { fr.contentWindow.postMessage(_awayPayload, IFRAME_ORIGIN); } catch (_) {}
        }
      } else if (d.type === "WL_LOCK_ACTION" && d.action === "resume") {
        send({ type: "RESUME" }).then((r) => { if (r && r.ok) removeOverlay(); });
      }
    });
  }

  // Away-from-desk: full-screen iframe to the hosted page; state relayed via postMessage.
  function buildAwayIframe(p) {
    const bn = document.getElementById(OV + "_banner"); if (bn) bn.remove();
    _awayPayload = awayStatePayload(p);
    let ov = document.getElementById(OV);
    if (!ov || !document.getElementById(OV + "_frame")) {
      if (ov) ov.remove();
      ov = document.createElement("div");
      ov.id = OV;
      ov.setAttribute("style", "position:fixed!important;inset:0!important;z-index:2147483646!important;background:#0b1020!important;margin:0!important;padding:0!important;border:0!important;");
      const f = document.createElement("iframe");
      f.id = OV + "_frame";
      f.setAttribute("allow", "fullscreen");
      f.setAttribute("style", "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;border:0!important;margin:0!important;display:block!important;");
      f.src = IFRAME_URL;
      ov.appendChild(f);
      (document.body || document.documentElement).appendChild(ov);
      // If the hosted page doesn't answer within 8s (host down / blocked / offline), fall back to
      // the built-in lock for 5 minutes so the user never faces a blank, un-dismissable screen.
      _frameReady = false;
      if (_frameTimer) clearTimeout(_frameTimer);
      _frameTimer = setTimeout(() => {
        _frameTimer = null;
        if (_frameReady || !document.getElementById(OV + "_frame")) return;
        _frameFailUntil = Date.now() + 5 * 60 * 1000;
        removeOverlay();
        evaluate();
      }, 8000);
    } else {
      // Already showing: just push the freshest state in.
      const fr = document.getElementById(OV + "_frame");
      if (fr && fr.contentWindow) { try { fr.contentWindow.postMessage(_awayPayload, IFRAME_ORIGIN); } catch (_) {} }
    }
    bindIframeMessages();
    if (!mo) {
      mo = new MutationObserver(() => { if (!document.getElementById(OV)) evaluate(); });
      try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
    }
  }

  function buildLock(p) {
    const c = COPY[p.state] || COPY.out;
    ensureStyle();
    const bn = document.getElementById(OV + "_banner"); if (bn) bn.remove();
    let ov = document.getElementById(OV);
    if (ov && document.getElementById(OV + "_frame")) { ov.remove(); ov = null; } // was the away iframe — rebuild clean
    if (!ov) { ov = document.createElement("div"); ov.id = OV; (document.body || document.documentElement).appendChild(ov); }
    ov.innerHTML = `
      <div class="wl-card">
        <div class="wl-ic" id="__wl_ic">${c.icon}</div>
        <h1>${esc(c.title)}</h1>
        <p>${esc(c.body)}</p>
        <div class="wl-clock" id="__wl_clock"></div>
        <button class="wl-primary" id="__wl_resume" ${c.resume ? "" : "disabled"}>${c.resume ? "Resume work" : "Scan in at the gate to resume"}</button>
        <div class="wl-note" id="__wl_note"></div>
        <button class="wl-link" id="__wl_recheck">Scanned in but still locked? Re-check</button>
        ${p.state === "out" ? `<div class="wl-else"><button class="wl-link" id="__wl_otp_toggle">Someone else needs this desk?</button></div>
          <div class="wl-sec" id="__wl_otp" style="display:none;">
            <div id="__wl_otp_step1">
              <label>Your work email (@biotecnika.org)</label>
              <input id="__wl_otp_email" type="email" placeholder="you@biotecnika.org" autocomplete="off">
              <button class="wl-primary" id="__wl_otp_send">Send code</button>
            </div>
            <div id="__wl_otp_step2" style="display:none;">
              <label>Enter the 6-digit code sent to your email</label>
              <input id="__wl_otp_code" inputmode="numeric" maxlength="6" placeholder="••••••">
              <button class="wl-primary" id="__wl_otp_verify">Unlock desk</button>
            </div>
          </div>` : ""}
        <div class="wl-sec" id="__wl_admin" style="display:none;">
          <div class="wl-admin-ttl">Super-admin override</div>
          <div id="__wl_admin_s1"><button class="wl-primary" id="__wl_admin_send">Send override code to administrator</button></div>
          <div id="__wl_admin_s2" style="display:none;">
            <label>Enter the override code sent to the administrator</label>
            <input id="__wl_admin_code" inputmode="numeric" maxlength="6" placeholder="••••••">
            <button class="wl-primary" id="__wl_admin_unlock">Unlock (admin)</button>
          </div>
          <div class="wl-note" id="__wl_admin_note"></div>
        </div>
      </div>`;

    startClock();
    const note = document.getElementById("__wl_note");

    const resume = document.getElementById("__wl_resume");
    if (resume && c.resume) resume.onclick = async () => {
      resume.disabled = true; note.textContent = "Resuming…";
      const r = await send({ type: "RESUME" });
      if (r && r.ok) { note.textContent = ""; removeOverlay(); }
      else { note.textContent = "Please scan in at the gate first."; resume.disabled = false; }
    };

    const recheck = document.getElementById("__wl_recheck");
    if (recheck) recheck.onclick = async () => {
      note.textContent = "Checking the gate…";
      const r = await send({ type: "RECHECK" });
      const pr = r && r.presence;
      if (!pr) { note.textContent = "Couldn’t reach the server — try again."; return; }
      if (!LOCKED.includes(pr.state)) { note.textContent = ""; evaluate(); return; }
      note.textContent = pr.last_entry_ts
        ? "Gate’s latest entry: " + new Date(pr.last_entry_ts).toLocaleString() + ". Still showing you out — please scan in again."
        : "No gate entry found for you — please scan in at the gate.";
    };

    const toggle = document.getElementById("__wl_otp_toggle");
    if (toggle) toggle.onclick = () => { const o = document.getElementById("__wl_otp"); o.style.display = o.style.display === "none" ? "block" : "none"; };
    const sendBtn = document.getElementById("__wl_otp_send");
    if (sendBtn) sendBtn.onclick = async () => {
      const email = (document.getElementById("__wl_otp_email").value || "").trim();
      note.textContent = "Sending…";
      const r = await send({ type: "OTP_REQUEST", email });
      if (r && r.ok) { note.textContent = "Code sent. Check your email."; document.getElementById("__wl_otp_step1").style.display = "none"; document.getElementById("__wl_otp_step2").style.display = "block"; }
      else note.textContent = "Couldn’t send a code" + (r && r.reason ? " (" + r.reason + ")" : "") + ".";
    };
    const verifyBtn = document.getElementById("__wl_otp_verify");
    if (verifyBtn) verifyBtn.onclick = async () => {
      const email = (document.getElementById("__wl_otp_email").value || "").trim();
      const code = (document.getElementById("__wl_otp_code").value || "").trim();
      note.textContent = "Verifying…";
      const r = await send({ type: "OTP_VERIFY", email, code });
      if (r && r.ok) { note.textContent = ""; evaluate(); }
      else note.textContent = r && r.reason === "bad_code" ? `Wrong code (${r.attempts_left ?? "?"} left).` : "Verification failed" + (r && r.reason ? " (" + r.reason + ")" : "") + ".";
    };

    const an = document.getElementById("__wl_admin_note");
    const aSend = document.getElementById("__wl_admin_send");
    if (aSend) aSend.onclick = async () => {
      an.textContent = "Sending code to administrator…";
      const r = await send({ type: "ADMIN_REQUEST" });
      if (r && r.ok) { an.textContent = "Code sent to the administrator."; document.getElementById("__wl_admin_s1").style.display = "none"; document.getElementById("__wl_admin_s2").style.display = "block"; }
      else an.textContent = "Couldn’t send override code" + (r && r.reason ? " (" + r.reason + ")" : "") + ".";
    };
    const aUnlock = document.getElementById("__wl_admin_unlock");
    if (aUnlock) aUnlock.onclick = async () => {
      const code = (document.getElementById("__wl_admin_code").value || "").trim();
      an.textContent = "Verifying…";
      const r = await send({ type: "ADMIN_VERIFY", code });
      if (r && r.ok) { an.textContent = ""; evaluate(); }
      else an.textContent = r && r.reason === "bad_code" ? `Wrong code (${r.attempts_left ?? "?"} left).` : "Override failed" + (r && r.reason ? " (" + r.reason + ")" : "") + ".";
    };

    // Hidden override gesture: 5 quick taps on the lock icon.
    const ic = document.getElementById("__wl_ic");
    if (ic) {
      let taps = 0, t0 = 0;
      ic.addEventListener("click", () => {
        const now = Date.now();
        taps = (now - t0 > 3000) ? 1 : taps + 1;
        t0 = now;
        if (taps >= 5) { taps = 0; openAdmin(); }
      });
    }

    if (!mo) {
      mo = new MutationObserver(() => { if (!document.getElementById(OV)) evaluate(); });
      try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch {}
    }
  }

  function startClock() {
    if (clockTimer) clearInterval(clockTimer);
    const tick = () => { const el = document.getElementById("__wl_clock"); if (el) el.textContent = new Date().toLocaleTimeString(); };
    tick(); clockTimer = setInterval(tick, 1000);
  }

  function openAdmin() {
    const a = document.getElementById("__wl_admin");
    if (!a) return;
    a.style.display = (a.style.display === "none" || !a.style.display) ? "block" : "none";
    try { a.scrollIntoView({ block: "nearest" }); } catch {}
    const inp = document.getElementById("__wl_admin_code");
    if (inp && a.style.display === "block") setTimeout(() => inp.focus(), 50);
  }

  async function evaluate() {
    const p = await getPresence();
    if (!p) { removeOverlay(); return; }
    if (p.state === "borrowed") { showBorrow(p); return; }
    if (LOCKED.includes(p.state)) {
      if (_rendered === p.state && document.getElementById(OV)) return; // keep OTP/admin input intact
      if (p.state === "away_at_desk" && Date.now() >= _frameFailUntil) buildAwayIframe(p); else buildLock(p);
      _rendered = p.state;
    } else {
      removeOverlay(); // working / disabled / wl_down / out_of_scope / no_*_record
    }
  }

  // Hidden super-admin override hotkey: Ctrl+Shift+U (e.code so layout/AltGr can't mangle it).
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyU" && document.getElementById("__wl_admin")) {
      openAdmin(); e.preventDefault(); e.stopPropagation();
    }
  }, true);

  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.cb_presence) evaluate(); }); } catch {}
  document.addEventListener("visibilitychange", () => { if (!document.hidden) evaluate(); });
  evaluate();
  setInterval(evaluate, 4000);
})();
