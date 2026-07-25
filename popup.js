let currentFilter = "active";

document.addEventListener("DOMContentLoaded", async () => {
  await render();

  document.getElementById("scanBtn").addEventListener("click", async () => {
    setStatus("Scanning... (15-30s)");
    const r = await chrome.runtime.sendMessage({ action: "manualScan" });
    if (r.success) {
      setStatus(`✅ Active: ${r.activeCount} | New: ${r.newCount} | Resolved: ${r.resolvedCount}`);
    } else {
      setStatus(`❌ ${r.error}`);
    }
    await render();
  });

  document.getElementById("exportBtn").addEventListener("click", exportJson);
  document.getElementById("clearBtn").addEventListener("click", async () => {
    if (confirm("Clear all findings?")) {
      await chrome.storage.local.set({ findings: {}, previousQueue: [], scanHistory: [] });
      chrome.action.setBadgeText({ text: "" });
      await render();
    }
  });

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      await render();
    });
  });
});

async function render() {
  const { findings = {}, lastScanAt } = await chrome.storage.local.get(["findings", "lastScanAt"]);
  const list = Object.values(findings);

  const active = list.filter(f => f.status === "active");
  const newOnes = list.filter(f => f.isNewInLastScan);
  const resolved = list.filter(f => f.status === "resolved");

  document.getElementById("stats").innerHTML = `
    <div class="stat"><span class="stat-num">${active.length}</span><span class="stat-lbl">🟢 Active</span></div>
    <div class="stat"><span class="stat-num">${newOnes.length}</span><span class="stat-lbl">🆕 New</span></div>
    <div class="stat"><span class="stat-num">${resolved.length}</span><span class="stat-lbl">✅ Resolved</span></div>
  `;

  if (!document.getElementById("status").textContent) {
    setStatus(`Last scan: ${lastScanAt ? new Date(lastScanAt).toLocaleString() : "Never"}`);
  }

  let filtered;
  if (currentFilter === "active") filtered = active;
  else if (currentFilter === "new") filtered = newOnes;
  else if (currentFilter === "resolved") filtered = resolved;
  else filtered = list;

  filtered.sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));

  const container = document.getElementById("findings");
  container.innerHTML = "";
  if (filtered.length === 0) {
    container.innerHTML = `<p class="empty">No ${currentFilter} findings.</p>`;
    return;
  }
  for (const f of filtered) container.appendChild(renderCard(f));
}

function renderCard(f) {
  const div = document.createElement("div");
  const cls = f.classification || {};
  const fc = f.fieldCheck || { present: [], missing: [], evidence: {} };
  const atts = f.attachments || [];
  const links = f.externalLinks || [];

  const statusCls = f.status === "resolved" ? "resolved" : (cls.status || "unknown").toLowerCase();
  div.className = "card status-" + statusCls;

  let statusIcon = "🟢";
  if (f.status === "resolved") statusIcon = "✅";
  else if (f.isNewInLastScan) statusIcon = "🆕";

  let clsBadge = "", categoryName = "—";
  if (cls.status === "CLASSIFIED") {
    clsBadge = `<span class="badge ok">CLASSIFIED (${cls.score})</span>`;
    categoryName = cls.category.name;
  } else if (cls.status === "AMBIGUOUS") {
    clsBadge = `<span class="badge warn">AMBIGUOUS</span>`;
    categoryName = cls.top2.map(t => `${t.category.name} (${t.score})`).join(" ↔ ");
  } else if (cls.status === "REDIRECT") {
    clsBadge = `<span class="badge info">REDIRECT</span>`;
    categoryName = cls.category.name;
  } else {
    clsBadge = `<span class="badge err">UNCLASSIFIABLE</span>`;
  }

  const missingLine = fc.missing.length > 0
    ? `<div class="miss">⚠️ Missing: ${fc.missing.join(", ")}</div>`
    : (fc.present.length > 0 ? `<div class="ok-line">✅ All mandatory fields present</div>` : "");

  // Evidence summary
  const imgCount = atts.filter(a => a.type === "image").length;
  const vidCount = atts.filter(a => a.type === "video").length;
  const podCount = atts.filter(a => a.type === "pod").length;
  const pdfCount = atts.filter(a => a.type === "pdf" || a.type === "invoice").length;
  const gdriveCount = links.filter(l => l.type === "gdrive").length;

  const evidenceParts = [];
  if (imgCount) evidenceParts.push(`🖼️ ${imgCount}`);
  if (vidCount) evidenceParts.push(`🎥 ${vidCount}`);
  if (podCount) evidenceParts.push(`📄 POD ${podCount}`);
  if (pdfCount) evidenceParts.push(`📕 ${pdfCount}`);
  if (gdriveCount) evidenceParts.push(`🔗 Drive`);
  const evidenceLine = evidenceParts.length > 0 ? `<div class="evidence">${evidenceParts.join(" • ")}</div>` : "";

  const inQueueFor = f.firstSeenAt ? timeAgo(f.firstSeenAt) : "—";
  const timeInfo = f.status === "resolved"
    ? ` • Resolved ${timeAgo(f.resolvedAt)}`
    : ` • In queue ${inQueueFor}`;

  div.innerHTML = `
    <div class="row">
      <span class="s-icon">${statusIcon}</span>
      <a href="https://issues.amazon.com/issues/${f.issueId}" target="_blank"><strong>${esc(f.title)}</strong></a>
      ${clsBadge}
    </div>
    <div class="meta">${esc(f.creator || "Unknown")}${timeInfo}</div>
    <div class="cat">${esc(categoryName)}</div>
    ${missingLine}
    ${evidenceLine}
  `;
  return div;
}

function timeAgo(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function setStatus(t) { document.getElementById("status").textContent = t; }

async function exportJson() {
  const store = await chrome.storage.local.get(["findings", "scanHistory", "lastScanAt"]);
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `fba-findings-${Date.now()}.json`; a.click();
  URL.revokeObjectURL(url);
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}