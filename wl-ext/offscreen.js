// ============================================================
// ChromeBoost Extension — offscreen.js (v2.4.0)
// Persistent capture timer. The MV3 service worker is suspended after ~30s,
// so it cannot drive a reliable sub-30s cadence on its own. This offscreen
// document is not suspended: it keeps a port open to the worker (keepalive)
// and posts a "tick" every CAPTURE_INTERVAL_MS. Each tick wakes the worker to
// take one screenshot. If the port drops (worker recycled), it reconnects.
// ============================================================

const CAPTURE_INTERVAL_MS = 5000; // ~12/min

let port = null;

function connect() {
  try {
    port = chrome.runtime.connect({ name: "cb-cap" });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 1000); // worker recycled — reconnect shortly
    });
  } catch (e) {
    port = null;
    setTimeout(connect, 1000);
  }
}

connect();

setInterval(() => {
  try {
    if (!port) connect();
    port && port.postMessage({ t: "tick" });
  } catch (e) {
    port = null;
    connect();
  }
}, CAPTURE_INTERVAL_MS);
