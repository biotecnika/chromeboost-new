// ============================================================
// WorkLens — LinkedIn feed ("river") blocker
// Blocks ONLY the LinkedIn home feed during work hours and shows a
// message. Jobs, Messaging, Search, profiles, notifications and the
// rest of LinkedIn stay fully usable (the top nav stays clickable).
//
// Scope: runs only on linkedin.com (see manifest content_scripts).
// SPA-aware: LinkedIn navigates client-side, so we re-check on every
// in-app route change (history API hook + popstate + interval safety net).
// ============================================================
(function () {
  "use strict";

  // ── Config — edit these to change behaviour (no code changes needed) ──
  const CFG = {
    enabled:    true,              // master on/off
    // Office laptops: the feed is blocked ALL the time. To restrict to work
    // hours instead, set scheduleEnabled:true and adjust days/startMin/endMin.
    scheduleEnabled: false,
    message:    "LinkedIn feed is blocked during work hours",
    submessage: "Jobs, Messaging, Search and profiles are still available — use the menu at the top.",
    days:     [1, 2, 3, 4, 5, 6],   // 0=Sun..6=Sat (only used if scheduleEnabled)
    startMin: 9 * 60 + 30,          // 09:30
    endMin:   18 * 60 + 30,         // 18:30
    navHeightPx: 52,                // leave the LinkedIn top nav bar usable
  };

  const STYLE_ID   = "wl-feed-block-style";
  const OVERLAY_ID = "wl-feed-block-overlay";
  const EXT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return "unknown"; } })();

  // ── Helpers ───────────────────────────────────────────────────────────
  function withinWorkHours() {
    if (!CFG.enabled) return false;
    if (!CFG.scheduleEnabled) return true;   // always-on
    const now = new Date();
    if (!CFG.days.includes(now.getDay())) return false;
    const mins = now.getHours() * 60 + now.getMinutes();
    return mins >= CFG.startMin && mins < CFG.endMin;
  }

  // The home feed ("river") is the bare root, /feed, and its tabs
  // (/feed/foryou, /feed/following, …). We still ALLOW individual post
  // permalinks (/feed/update/<post>) and leave /jobs, /messaging, /in/<profile>,
  // /search, /notifications, etc. untouched.
  function isFeedRoute() {
    const p = location.pathname.replace(/\/+$/, "");   // drop trailing slashes
    if (p === "" || p === "/feed") return true;
    if (p.startsWith("/feed/update/")) return false;   // a single post — allow
    if (p.startsWith("/feed/")) return true;           // feed tabs — block
    return false;
  }

  let _logged = false;
  function logBlockOnce() {
    if (_logged) return;
    _logged = true;
    try {
      const key = "cb_pending_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      chrome.storage.local.set({
        [key]: {
          event_type: "linkedin_feed_blocked",
          event_data: { url: location.href, domain: "linkedin.com", source: "browser", extension_version: EXT_VERSION },
          recorded_at: new Date().toISOString(),
        }
      });
    } catch (_) {}
  }

  // ── Block / unblock ───────────────────────────────────────────────────
  function showBlock() {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent =
        "#" + OVERLAY_ID + "{position:fixed;left:0;right:0;bottom:0;top:" + CFG.navHeightPx + "px;" +
        "z-index:2147483646;background:#f3f2ef;display:flex;align-items:center;justify-content:center;" +
        "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}" +
        "#" + OVERLAY_ID + " .wl-card{max-width:460px;text-align:center;padding:40px 32px;background:#fff;" +
        "border:1px solid #e0dfdc;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.06);margin:16px;}" +
        "#" + OVERLAY_ID + " .wl-ic{width:56px;height:56px;border-radius:50%;background:#eef3f8;display:flex;" +
        "align-items:center;justify-content:center;margin:0 auto 18px;}" +
        "#" + OVERLAY_ID + " h2{margin:0 0 10px;font-size:20px;font-weight:600;color:#1d2226;}" +
        "#" + OVERLAY_ID + " p{margin:0 0 20px;font-size:14px;line-height:1.5;color:#5e6670;}" +
        "#" + OVERLAY_ID + " .wl-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}" +
        "#" + OVERLAY_ID + " a.wl-b{display:inline-block;padding:8px 18px;border-radius:20px;font-size:14px;" +
        "font-weight:600;text-decoration:none;cursor:pointer;}" +
        "#" + OVERLAY_ID + " a.wl-primary{background:#0a66c2;color:#fff;}" +
        "#" + OVERLAY_ID + " a.wl-ghost{background:transparent;color:#0a66c2;border:1px solid #0a66c2;}";
      (document.head || document.documentElement).appendChild(st);
    }
    if (!document.getElementById(OVERLAY_ID)) {
      const ov = document.createElement("div");
      ov.id = OVERLAY_ID;
      ov.innerHTML =
        '<div class="wl-card">' +
          '<div class="wl-ic"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0a66c2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' +
          '<h2>' + CFG.message + '</h2>' +
          '<p>' + CFG.submessage + '</p>' +
          '<div class="wl-btns">' +
            '<a class="wl-b wl-primary" href="https://www.linkedin.com/jobs/">Go to Jobs</a>' +
            '<a class="wl-b wl-ghost" href="https://www.linkedin.com/messaging/">Messaging</a>' +
          '</div>' +
        '</div>';
      (document.body || document.documentElement).appendChild(ov);
    }
    logBlockOnce();
  }

  function hideBlock() {
    const ov = document.getElementById(OVERLAY_ID); if (ov) ov.remove();
    const st = document.getElementById(STYLE_ID);   if (st) st.remove();
    _logged = false;
  }

  function evaluate() {
    try {
      if (isFeedRoute() && withinWorkHours()) showBlock();
      else hideBlock();
    } catch (_) {}
  }

  // ── SPA navigation hooks ──────────────────────────────────────────────
  // LinkedIn is a single-page app: clicking "Home" does not reload the page,
  // so we must re-evaluate whenever the route changes.
  (function hookHistory() {
    const fire = () => window.dispatchEvent(new Event("wl-locationchange"));
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    }
    window.addEventListener("popstate", fire);
  })();

  window.addEventListener("wl-locationchange", evaluate);
  document.addEventListener("DOMContentLoaded", evaluate);
  window.addEventListener("load", evaluate);
  // Safety net: catch any route change the history hook misses, and keep the
  // overlay applied if the SPA re-renders. Cheap (just a few DOM checks).
  setInterval(evaluate, 1000);

  evaluate();
})();
