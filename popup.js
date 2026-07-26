let currentFilter = "active";

document.addEventListener("DOMContentLoaded", async () => {
  await render();

  document.getElementById("scanBtn").addEventListener("click", async () => {
    setStatus("Scanning... (15-30s)");
    const r = await chrome.runtime.sendMessage({ action: "manualScan" });
    if (r.success) setStatus(`✅ Active: ${r.activeCount} | New: ${r.newCount} | Resolved: ${r.resolvedCount}`);
    else setStatus(`❌ ${r.error}`);
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

  document.getElementById("findings").addEventListener("click", async (e) => {
    const btn = e.target.closest(".draft-btn");
    if (btn) {
      e.preventDefault(); e.stopPropagation();
      await openDraftModal(btn.dataset.issueId);
    }
  });

  document.getElementById("closeModal").addEventListener("click", closeModal);
  document.getElementById("copyBtn").addEventListener("click", async () => {
    const text = document.getElementById("commentText").value;
    await navigator.clipboard.writeText(text);
    document.getElementById("copyBtn").textContent = "✅ Copied!";
    setTimeout(() => document.getElementById("copyBtn").textContent = "📋 Copy", 2000);
  });
  document.getElementById("postBtn").addEventListener("click", async () => {
    const issueId = document.getElementById("commentModal").dataset.issueId;
    const commentText = document.getElementById("commentText").value;
    document.getElementById("postBtn").textContent = "⏳ Opening...";
    const res = await chrome.runtime.sendMessage({
      action: "fillCommentInSim", issueId, commentText
    });
    if (res.success) {
      document.getElementById("postBtn").textContent = "✅ Drafted in SIM";
      setTimeout(closeModal, 2000);
    } else {
      document.getElementById("postBtn").textContent = "❌ " + (res.error || "Failed");
    }
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
  const fc = f.fieldCheck || { present: [], missing: [], optionalPresent: [], optionalMissing: [] };
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

  const optionalLine = fc.optionalMissing && fc.optionalMissing.length > 0
    ? `<div class="opt">💡 Recommended: ${fc.optionalMissing.join(", ")}</div>` : "";

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

  const showDraftBtn = fc.missing && fc.missing.length > 0 &&
    (cls.status === "CLASSIFIED" || cls.status === "AMBIGUOUS");
  const draftBtnHtml = showDraftBtn
    ? `<div class="card-actions"><button class="draft-btn" data-issue-id="${f.issueId}">📝 Draft Comment</button></div>`
    : "";

  div.innerHTML = `
    <div class="row">
      <span class="s-icon">${statusIcon}</span>
      <a href="https://issues.amazon.com/issues/${f.issueId}" target="_blank"><strong>${esc(f.title)}</strong></a>
      ${clsBadge}
    </div>
    <div class="meta">${esc(f.creator || "Unknown")}${timeInfo}</div>
    <div class="cat">${esc(categoryName)}</div>
    ${missingLine}
    ${optionalLine}
    ${evidenceLine}
    ${draftBtnHtml}
  `;
  return div;
}

async function openDraftModal(issueId) {
  const { findings = {} } = await chrome.storage.local.get(["findings"]);
  const finding = findings[issueId];
  if (!finding) return;

  const commentText = generateCommentText(finding);
  const modal = document.getElementById("commentModal");
  modal.dataset.issueId = issueId;
  document.getElementById("commentText").value = commentText;
  document.getElementById("modalInfo").innerHTML =
    `<strong>${esc(finding.title)}</strong><br>Missing: ${(finding.fieldCheck?.missing || []).join(", ") || "None"}`;
  document.getElementById("postBtn").textContent = "🚀 Open Ticket & Auto-Fill";
  document.getElementById("copyBtn").textContent = "📋 Copy";
  modal.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("commentModal").classList.add("hidden");
}

function generateCommentText(finding) {
  const creator = finding.creator && finding.creator !== "Unknown" ? finding.creator : "Team";
  const category = finding.classification.category?.name || "reimbursement";
  const missing = finding.fieldCheck?.missing || [];
  const optionalMissing = finding.fieldCheck?.optionalMissing || [];
  const window = finding.classification.category?.claimWindowDays;
  const windowFrom = finding.classification.category?.claimWindowFrom;
  const sampleFormat = finding.classification.category?.sampleFormat;

  let text = `Hi ${creator},\n\n`;
  text += `To process this "${category}" claim, we need the following mandatory details which are currently missing or unclear:\n\n`;
  missing.forEach(f => text += `• ${f}\n`);

  if (optionalMissing.length > 0) {
    text += `\nRecommended (helpful but not blocking):\n`;
    optionalMissing.forEach(f => text += `• ${f}\n`);
  }
  text += `\n`;

  if (sampleFormat) {
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📋 SAMPLE FORMAT for future submissions\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `Please use this format when raising ${category} issues:\n\n`;
    text += sampleFormat;
    text += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  text += `How to provide the missing details:\n`;
  text += `- Reply to this ticket as a comment (following the format above)\n`;
  text += `- Attach documents/images/videos directly to the ticket\n`;
  text += `- Share Google Drive / YouTube link for large video files\n\n`;

  if (window && windowFrom) {
    text += `⚠️ IMPORTANT: Claim window is ${window} days from ${windowFrom.replace(/_/g, ' ')}. Please submit within this window to avoid claim denial.\n\n`;
  }

  text += `Reference: ${finding.title}\n`;
  if (finding.srTag) text += `SR Tag: ${finding.srTag}\n`;
  text += `Category: ${category}\n\n`;
  text += `Following this format going forward will help us process your claims faster.\n\n`;
  text += `Thanks for your cooperation!\n`;
  return text;
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