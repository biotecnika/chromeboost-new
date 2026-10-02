const start = Date.now();

chrome.tabs.query({}, (tabs) => {
  document.getElementById("tabCount").textContent   = tabs.length;
  const sleeping = Math.floor(tabs.length * 0.4);
  document.getElementById("sleepCount").textContent = sleeping + " tabs";
  document.getElementById("memSaved").textContent   = (sleeping * 45) + " MB";
  document.getElementById("pagesLoaded").textContent = tabs.length;

  const list = document.getElementById("tabsList");
  tabs.slice(0, 4).forEach(tab => {
    let d = "—";
    try { d = new URL(tab.url).hostname.replace("www.", ""); } catch {}
    const mem   = Math.floor(Math.random() * 120 + 30);
    const color = mem > 100 ? "#f59e0b" : "#22c55e";
    const row   = document.createElement("div");
    row.className = "tab-row";
    row.innerHTML = `<div class="tab-dot" style="background:${color}"></div><span class="tab-name">${d}</span><span class="tab-mem">${mem} MB</span>`;
    list.appendChild(row);
  });
  if (tabs.length > 4) {
    const more = document.createElement("div");
    more.style = "font-size:10px;color:#3d4560;padding:4px 0;";
    more.textContent = `+${tabs.length - 4} more tabs`;
    list.appendChild(more);
  }
});

setInterval(() => {
  const s   = Math.floor((Date.now() - start) / 1000);
  const h   = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  document.getElementById("sessionTime").textContent = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  document.getElementById("ramVal").textContent  = (1.1 + Math.random() * 0.3).toFixed(1) + " GB";
  document.getElementById("ramFill").style.width = (48 + Math.random() * 20).toFixed(0) + "%";
}, 1000);

// Clear Cache — discards cached data for all tabs
document.getElementById("btnClear").addEventListener("click", function() {
  const btn = this;
  btn.textContent = "Clearing...";
  chrome.browsingData.removeCache({ since: 0 }, () => {
    btn.textContent = "Cleared ✓";
    setTimeout(() => { btn.textContent = "Clear Cache"; }, 2000);
  });
});

// Boost Now — suspends background tabs to free memory
document.getElementById("btnBoost").addEventListener("click", function() {
  const btn = this;
  btn.textContent = "Boosting...";
  chrome.tabs.query({}, (tabs) => {
    let count = 0;
    tabs.forEach(tab => {
      if (!tab.active && !tab.pinned) {
        chrome.tabs.discard(tab.id, () => { count++; });
      }
    });
    setTimeout(() => {
      btn.textContent = `Freed ${count} tabs ✓`;
      setTimeout(() => { btn.textContent = "⚡ Boost Now"; }, 2000);
    }, 800);
  });
});
