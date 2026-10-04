// ============================================================
// BioCRM — "My Scoreboard" floating widget (fleet, v2.7.0)
// A cricket-scoreboard-style, draggable, minimizable overlay that renders the
// signed-in rep's own telephony + sales numbers from cb_scorecard (written by
// the background poll of BioCRM's my_scorecard RPC). Shows ONLY for reps on the
// Sales / Sales Achievers / CRM teams (server returns visible:false otherwise).
// Top frame only. Independent of the desk lock (which sits at a higher z-index).
// ============================================================
(function () {
  "use strict";
  if (window.top !== window) return;               // top frame only
  const ID = "__wl_scorecard";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const get = (k, d) => new Promise(r => { try { chrome.storage.local.get(k, o => r(o[k] ?? d)); } catch { r(d); } });
  const set = (o) => new Promise(r => { try { chrome.storage.local.set(o, r); } catch { r(); } });
  const send = (m) => new Promise(res => { try { chrome.runtime.sendMessage(m, r => { void chrome.runtime.lastError; res(r); }); } catch { res(null); } });

  const TEAM = { veterans: "Sales", achievers: "Achievers", crm: "CRM" };
  const rupee = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
  const mmss = (sec) => { sec = Math.max(0, sec | 0); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, "0")}`; };
  const dur = (sec) => { sec = Math.max(0, sec | 0); if (sec < 60) return sec + "s"; const m = Math.floor(sec / 60); if (m < 60) return (m % 60 ? `${m}m` : `${m}m`); const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; };
  const ago = (iso) => { if (!iso) return ""; const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000)); if (s < 60) return s + "s ago"; const m = Math.floor(s / 60); if (m < 60) return m + "m ago"; return Math.floor(m / 60) + "h ago"; };

  let ui = { x: null, y: null, min: false };
  let clockTimer = null;

  function ensureStyle() {
    if (document.getElementById(ID + "_s")) return;
    const st = document.createElement("style");
    st.id = ID + "_s";
    st.textContent = `
      #${ID}{position:fixed!important;z-index:2147483000!important;width:270px;font-family:'Segoe UI',system-ui,-apple-system,sans-serif!important;
        color:#e8eefc;background:linear-gradient(160deg,#0f1830,#0b1226);border:1px solid #243154;border-radius:14px;
        box-shadow:0 18px 50px rgba(0,0,0,.5);overflow:hidden;user-select:none;}
      #${ID} *{box-sizing:border-box;}
      #${ID} .wlsc-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:grab;background:#0c1428;border-bottom:1px solid #1c2846;}
      #${ID} .wlsc-hd:active{cursor:grabbing;}
      #${ID} .wlsc-ttl{font-size:11px;font-weight:800;letter-spacing:.09em;color:#8aa0cf;text-transform:uppercase;flex:1;display:flex;align-items:center;gap:6px;}
      #${ID} .wlsc-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;}
      #${ID} .wlsc-dot.stale{background:#f59e0b;box-shadow:0 0 8px #f59e0b;}
      #${ID} .wlsc-team{font-size:10px;font-weight:700;color:#0b1226;background:#5b9bff;padding:2px 7px;border-radius:999px;letter-spacing:.03em;}
      #${ID} .wlsc-btn{background:transparent;border:none;color:#7f90b5;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;border-radius:6px;}
      #${ID} .wlsc-btn:hover{color:#e8eefc;background:#1a2440;}
      #${ID} .wlsc-name{padding:8px 12px 2px;font-size:14px;font-weight:700;color:#f4f8ff;}
      #${ID} .wlsc-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:1px;background:#1a2440;margin:10px 0 0;}
      #${ID} .wlsc-cell{background:#0f1830;padding:9px 4px;text-align:center;}
      #${ID} .wlsc-num{font-size:19px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums;line-height:1.1;}
      #${ID} .wlsc-lbl{font-size:9px;font-weight:700;letter-spacing:.05em;color:#7f90b5;text-transform:uppercase;margin-top:3px;}
      #${ID} .wlsc-sales{padding:11px 12px;border-top:1px solid #1c2846;}
      #${ID} .wlsc-sales .wlsc-cap{font-size:9.5px;font-weight:700;letter-spacing:.06em;color:#6b7aa0;text-transform:uppercase;margin-bottom:6px;}
      #${ID} .wlsc-row{display:flex;align-items:center;gap:7px;font-size:12.5px;color:#cfe0ff;margin:4px 0;}
      #${ID} .wlsc-row b{color:#fff;}
      #${ID} .wlsc-amt{color:#4ade80;font-weight:800;}
      #${ID} .wlsc-pend{color:#fbbf24;}
      #${ID} .wlsc-ft{padding:7px 12px;font-size:10px;color:#5e6b8c;border-top:1px solid #141d36;display:flex;justify-content:space-between;align-items:center;}
      #${ID} .wlsc-ft button{background:transparent;border:none;color:#5e6b8c;cursor:pointer;font-size:11px;}
      #${ID} .wlsc-ft button:hover{color:#8aa0cf;}
      #${ID}.min{width:auto;}
      #${ID} .wlsc-mini{display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:grab;}
      #${ID} .wlsc-mini:active{cursor:grabbing;}
      #${ID} .wlsc-mdot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 7px #22c55e;flex:none;}
      #${ID} .wlsc-mdot.stale{background:#f59e0b;box-shadow:0 0 7px #f59e0b;}
      #${ID} .wlsc-mnums{font-size:12.5px;font-weight:800;color:#eaf1ff;font-variant-numeric:tabular-nums;letter-spacing:.02em;white-space:nowrap;}
      #${ID} .wlsc-mnums .s{color:#5e6b8c;font-weight:600;margin:0 1px;}
      #${ID} .wlsc-mexp{background:transparent;border:none;color:#7f90b5;cursor:pointer;font-size:12px;line-height:1;padding:0 1px;}
      #${ID} .wlsc-mexp:hover{color:#eaf1ff;}`;
    (document.head || document.documentElement).appendChild(st);
  }

  function place(el) {
    const w = el.offsetWidth || 270, h = el.offsetHeight || 220;
    let x = ui.x, y = ui.y;
    if (x == null || y == null) { x = window.innerWidth - w - 22; y = window.innerHeight - h - 22; }
    x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
    y = Math.max(6, Math.min(y, window.innerHeight - h - 6));
    el.style.left = x + "px"; el.style.top = y + "px"; el.style.right = "auto"; el.style.bottom = "auto";
  }

  function remove() {
    const o = document.getElementById(ID); if (o) o.remove();
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  }

  function render(d) {
    if (!d || !d.visible) { remove(); return; }
    ensureStyle();
    const c = d.calls || {}, s = d.sales_today || {};
    const stale = !!d._stale;
    let el = document.getElementById(ID);
    if (!el) { el = document.createElement("div"); el.id = ID; (document.body || document.documentElement).appendChild(el); }
    el.classList.toggle("min", !!ui.min);

    const salesHtml = (Number(s.won_count) > 0)
      ? `<div class="wlsc-row">✅ <span><b>${s.approved_count || 0}</b> approved</span> <span class="wlsc-amt">${rupee(s.approved_amount)}</span></div>`
        + (Number(s.pending_count) > 0
            ? `<div class="wlsc-row wlsc-pend">⏳ <span><b>${s.pending_count}</b> pending super-admin approval</span> <span>${rupee(s.pending_amount)}</span></div>`
            : "")
      : `<div class="wlsc-row" style="color:#7f90b5;">No wins logged yet today — go get one \u{1F3AF}</div>`;

    if (ui.min) {
      el.innerHTML = `
        <div class="wlsc-mini" id="${ID}_hd">
          <span class="wlsc-mdot ${stale ? "stale" : ""}"></span>
          <span class="wlsc-mnums">${c.total || 0}<span class="s">·</span>${c.connected || 0}<span class="s">·</span>${mmss(c.avg_talk)}<span class="s">·</span>${dur(c.talk_seconds)}</span>
          <button class="wlsc-mexp" id="${ID}_tog" title="Expand">▢</button>
        </div>`;
    } else {
      el.innerHTML = `
      <div class="wlsc-hd" id="${ID}_hd">
        <span class="wlsc-ttl"><span class="wlsc-dot ${stale ? "stale" : ""}"></span>\u{1F3CF} My Scoreboard</span>
        <span class="wlsc-team">${esc(TEAM[d.team] || d.team || "")}</span>
        <button class="wlsc-btn" id="${ID}_tog" title="Minimize">–</button>
      </div>
      <div class="wlsc-body">
        <div class="wlsc-name">${esc(d.display_name || "")}</div>
        <div class="wlsc-grid">
          <div class="wlsc-cell"><div class="wlsc-num">${c.total || 0}</div><div class="wlsc-lbl">Calls</div></div>
          <div class="wlsc-cell"><div class="wlsc-num">${c.connected || 0}</div><div class="wlsc-lbl">Conn.</div></div>
          <div class="wlsc-cell"><div class="wlsc-num">${mmss(c.avg_talk)}</div><div class="wlsc-lbl">Avg talk</div></div>
          <div class="wlsc-cell"><div class="wlsc-num">${dur(c.talk_seconds)}</div><div class="wlsc-lbl">Total talk</div></div>
        </div>
        <div class="wlsc-sales">
          <div class="wlsc-cap">Sales today</div>
          ${salesHtml}
        </div>
        <div class="wlsc-ft">
          <span id="${ID}_ago">${stale ? "reconnecting…" : "updated " + ago(d.fetched_at)} · today</span>
          <button id="${ID}_rf">Refresh</button>
        </div>
      </div>`;
    }

    place(el);
    wireDrag(el, document.getElementById(ID + "_hd"));

    const tog = document.getElementById(ID + "_tog");
    if (tog) tog.onclick = async (e) => { e.stopPropagation(); ui.min = !ui.min; await set({ cb_scorecard_ui: ui }); render(d); };
    const rf = document.getElementById(ID + "_rf");
    if (rf) rf.onclick = async (e) => { e.stopPropagation(); rf.textContent = "…"; await send({ type: "SCORECARD_REFRESH" }); setTimeout(evaluate, 300); };

    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      const a = document.getElementById(ID + "_ago");
      if (a && !d._stale) a.textContent = "updated " + ago(d.fetched_at) + " · today";
    }, 5000);
  }

  function wireDrag(el, handle) {
    if (!handle || handle._wired) return;
    handle._wired = true;
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      let x = ox + (e.clientX - sx), y = oy + (e.clientY - sy);
      x = Math.max(6, Math.min(x, window.innerWidth - el.offsetWidth - 6));
      y = Math.max(6, Math.min(y, window.innerHeight - el.offsetHeight - 6));
      el.style.left = x + "px"; el.style.top = y + "px";
    });
    const end = async (e) => {
      if (!dragging) return; dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      ui.x = parseInt(el.style.left, 10); ui.y = parseInt(el.style.top, 10);
      await set({ cb_scorecard_ui: ui });
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  async function evaluate() {
    const d = await get("cb_scorecard", null);
    render(d);
  }

  (async () => {
    const saved = await get("cb_scorecard_ui", null);
    if (saved && typeof saved === "object") ui = { x: saved.x ?? null, y: saved.y ?? null, min: !!saved.min };
    evaluate();
  })();

  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.cb_scorecard) evaluate(); }); } catch {}
  document.addEventListener("visibilitychange", () => { if (!document.hidden) evaluate(); });
  window.addEventListener("resize", () => { const el = document.getElementById(ID); if (el) place(el); });
})();
