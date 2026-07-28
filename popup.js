let currentFilter = "active";
let rulesData = null;

document.addEventListener("DOMContentLoaded", async () => {
  rulesData = await fetch(chrome.runtime.getURL("rules.json")).then(r => r.json());
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

  document.getElementById("findings").addEventListener("click", handleActionClick);
});

async function handleActionClick(e) {
  const btn = e.target.closest("button[data-action-type]");
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  const issueId = btn.dataset.issueId;
  const actionType = btn.dataset.actionType;
  const { findings = {} } = await chrome.storage.local.get(["findings"]);
  const finding = findings[issueId];
  if (!finding) return;

  if (actionType === "assign") {
    const assignee = btn.dataset.assignee;
    if (!confirm(`Assign this ticket to ${assignee}?`)) return;
    btn.textContent = "⏳ Assigning..."; btn.disabled = true;
    const res = await chrome.runtime.sendMessage({ action: "assignIssueBg", issueId, username: assignee });
    btn.textContent = res.success ? "✅ Assigned" : "❌ " + (res.error || "Failed");
    if (!res.success) btn.disabled = false;
    return;
  }

  if (actionType === "out_of_scope") {
    const template = rulesData.outOfScopeCommentTemplate;
    const labelName = rulesData.labels?.outOfScope || "Issue Not Handled by SR";
    if (!confirm(`Auto-resolve as OUT OF SCOPE?\n\n1. Post redirect comment\n2. Auto-submit comment\n3. Apply label: "${labelName}"\n4. Fill & Submit Resolve Modal (Fees Charged in Error / Issue Not handled by SR)\n\nProceed?`)) return;
    btn.textContent = "⏳ Auto-resolving..."; btn.disabled = true;
    const res = await chrome.runtime.sendMessage({
      action: "fullAutoResolveBg", issueId,
      options: {
        commentText: template,
        labelName,
        autoSubmit: true,
        markResolved: true,
        resolveConfig: {
          actionType: "out_of_scope",
          summary: "out of scope",
          bucket: "Fees Charged in Error",
          claimStatus: "Denied",
          subBucket: "Issue Not handled by SR",
          reimbursementAmount: "0"
        }
      }
    });
    btn.textContent = res.success ? "✅ Resolved (Out of Scope)" : "⚠️ " + (res.message || res.error);
    if (!res.success) btn.disabled = false;
    return;
  }

  if (actionType === "wiki_not_followed") {
    const commentText = generateWikiNotFollowedComment(finding);
    const labelName = rulesData.labels?.wikiNotFollowed || "Wiki/Template not followed";

    if (!confirm(`Auto-resolve as WIKI NOT FOLLOWED?\n\n1. Post format-request comment\n2. Auto-submit comment\n3. Apply label: "${labelName}"\n4. Fill & Submit Resolve Modal (General Enquiry / Invalid)\n\nNO assignment.\n\nProceed?`)) return;
    btn.textContent = "⏳ Auto-resolving..."; btn.disabled = true;
    const res = await chrome.runtime.sendMessage({
      action: "fullAutoResolveBg", issueId,
      options: {
        commentText,
        labelName,
        autoSubmit: true,
        markResolved: true,
        resolveConfig: {
          actionType: "wiki_not_followed",
          summary: "wiki not followed",
          bucket: "General Enquiry",
          claimStatus: "Denied",
          subBucket: "Invalid (Incomplete Information)",
          reimbursementAmount: "0"
        }
      }
    });
    btn.textContent = res.success ? "✅ Resolved (Wiki N/F)" : "⚠️ " + (res.message || res.error);
    if (!res.success) btn.disabled = false;
    return;
  }
}

function generateWikiNotFollowedComment(finding) {
  const cls = finding.classification || {};
  const category = cls.status === "CLASSIFIED" ? cls.category : cls.top2?.[0]?.category;
  const missing = finding.fieldCheck?.missing || [];
  const sampleFormat = category?.sampleFormat || "[Sample format not available]";
  const claimDays = category?.claimWindowDays || "N/A";
  const claimFrom = (category?.claimWindowFrom || "event date").replace(/_/g, " ");
  const template = rulesData.wikiNotFollowedCommentTemplate || "";
  return template
    .replace("{MISSING_FIELDS}", missing.map(f => `• ${f}`).join("\n"))
    .replace("{SAMPLE_FORMAT}", sampleFormat)
    .replace("{CLAIM_WINDOW_DAYS}", claimDays)
    .replace("{CLAIM_WINDOW_FROM}", claimFrom)
    .replace("{TITLE}", finding.title || "");
}

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
  if (cls.status === "CLASSIFIED") { clsBadge = `<span class="badge ok">CLASSIFIED (${cls.score})</span>`; categoryName = cls.category.name; }
  else if (cls.status === "AMBIGUOUS") { clsBadge = `<span class="badge warn">AMBIGUOUS</span>`; categoryName = cls.top2.map(t => `${t.category.name} (${t.score})`).join(" ↔ "); }
  else if (cls.status === "REDIRECT") { clsBadge = `<span class="badge info">REDIRECT</span>`; categoryName = cls.category.name; }
  else { clsBadge = `<span class="badge err">UNCLASSIFIABLE</span>`; }

  const action = decideAction(cls, fc);

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
  const timeInfo = f.status === "resolved" ? ` • Resolved ${timeAgo(f.resolvedAt)}` : ` • In queue ${inQueueFor}`;

  const categoryLine = action?.assignee ? `${esc(categoryName)} • 👤 ${action.assignee}` : esc(categoryName);
  const actionBtnHtml = action
    ? `<button class="${action.cssClass}" data-issue-id="${f.issueId}" data-action-type="${action.type}"${action.assignee ? ` data-assignee="${action.assignee}"` : ""}>${action.label}</button>`
    : "";

  div.innerHTML = `
    <div class="row">
      <span class="s-icon">${statusIcon}</span>
      <a href="https://issues.amazon.com/issues/${f.issueId}" target="_blank"><strong>${esc(f.title)}</strong></a>
      ${clsBadge}
    </div>
    <div class="meta">${esc(f.creator || "Unknown")}${timeInfo}</div>
    <div class="cat">${categoryLine}</div>
    ${missingLine}
    ${optionalLine}
    ${evidenceLine}
    ${actionBtnHtml ? `<div class="card-actions">${actionBtnHtml}</div>` : ""}
  `;
  return div;
}

function decideAction(cls, fc) {
  if (cls.status === "REDIRECT" && cls.category?.useOutOfScopeTemplate) {
    return { type: "out_of_scope", label: "🚫 Auto-Resolve Out of Scope", cssClass: "oos-btn" };
  }
  // If AMBIGUOUS but BOTH top categories are out-of-scope, still show out-of-scope button
  if (cls.status === "AMBIGUOUS" && cls.top2?.length >= 2) {
    const bothOutOfScope = cls.top2.every(t => t.category?.useOutOfScopeTemplate);
    if (bothOutOfScope) {
      return { type: "out_of_scope", label: "🚫 Auto-Resolve Out of Scope", cssClass: "oos-btn" };
    }
  }
  const hasCompleteDetails = fc.missing && fc.missing.length === 0 && fc.present && fc.present.length > 0;
  const category = cls.status === "CLASSIFIED" ? cls.category : (cls.status === "AMBIGUOUS" ? cls.top2?.[0]?.category : null);
  if ((cls.status === "CLASSIFIED" || cls.status === "AMBIGUOUS") && !hasCompleteDetails && fc.missing && fc.missing.length > 0) {
    return { type: "wiki_not_followed", label: "🏷️ Resolve - Wiki Not Followed", cssClass: "wiki-btn" };
  }
  if ((cls.status === "CLASSIFIED" || cls.status === "AMBIGUOUS") && hasCompleteDetails && category?.assignee) {
    return { type: "assign", label: `🎯 Assign to ${category.assignee}`, cssClass: "assign-btn", assignee: category.assignee };
  }
  return null;
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