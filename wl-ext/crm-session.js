// ============================================================
// BioCRM session relay (v2.7.0) — runs only on crm.biotecnika.org.
// Reads the rep's Supabase auth session from the CRM's own localStorage and
// relays it to the background worker, which uses it to authenticate the
// identity-bound my_scorecard RPC. On the production domain the CRM stores the
// session in plain localStorage (the preview-broker path is not active here),
// so this is a straight read. Never sends anything anywhere except the
// extension's own background worker.
// ============================================================
(function () {
  "use strict";
  if (window.top !== window) return; // top frame only

  function readSession() {
    try {
      let raw = localStorage.getItem("sb-dozhxqakzqhhoizgzyxb-auth-token");
      if (!raw) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && /^sb-.*-auth-token$/.test(k)) { raw = localStorage.getItem(k); break; }
        }
      }
      if (!raw) return null;
      const o = JSON.parse(raw);
      const s = (o && o.currentSession) ? o.currentSession : o;   // v1 nests, v2 is flat
      if (!s || !s.access_token) return null;
      return {
        access_token: s.access_token,
        refresh_token: s.refresh_token || null,
        expires_at: s.expires_at || null
      };
    } catch (_) { return null; }
  }

  function push() {
    const s = readSession();
    try { chrome.runtime.sendMessage({ type: "CRM_SESSION", session: s }, () => { void chrome.runtime.lastError; }); } catch (_) {}
  }

  push();
  setInterval(push, 60000); // re-sync periodically (the CRM refreshes its token in place)
  window.addEventListener("storage", (e) => { if (e.key && /auth-token/.test(e.key)) push(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) push(); });
})();
