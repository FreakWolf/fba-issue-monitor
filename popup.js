let currentFilter = "active";
let rulesData = null;

document.addEventListener("DOMContentLoaded", async () => {
  rulesData = await fetch(chrome.runtime.getURL("rules.json")).then(r => r.json());
  await render();
  await initAutoModeToggle();

  document.getElementById("scanBtn").addEventListener("click", async () => {
    setStatus("Scanning... (15-30s)");
    const r = await chrome.runtime.sendMessage({ action: "manualScan" });
    if (r.success) setStatus(`Done. Active: ${r.activeCount} | New: ${r.newCount} | Resolved: ${r.resolvedCount}`);
    else setStatus(`Error: ${r.error}`);
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

async function initAutoModeToggle() {
  const toggle = document.getElementById("autoModeToggle");
  const hint = document.getElementById("autoModeHint");
  const res = await chrome.runtime.sendMessage({ action: "getAutoMode" });
  toggle.checked = res.autoMode || false;
  hint.textContent = toggle.checked ? "Autonomous" : "Manual";
  toggle.addEventListener("change", async () => {
    await chrome.runtime.sendMessage({ action: "setAutoMode", enabled: toggle.checked });
    hint.textContent = toggle.checked ? "Autonomous" : "Manual";
  });

  // SAFET Excel upload
  const uploadBtn = document.getElementById("uploadSafetBtn");
  const fileInput = document.getElementById("safetFileInput");
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    uploadBtn.textContent = "⏳ Processing...";
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const allRows = XLSX.utils.sheet_to_json(sheet, { defval: "", header: 1 });

      // Find the header row (contains "Order ID" and "Channel")
      let headerIdx = -1;
      for (let i = 0; i < Math.min(allRows.length, 20); i++) {
        const row = allRows[i] || [];
        if (row.some(cell => String(cell).toLowerCase().includes("order id")) &&
            row.some(cell => String(cell).toLowerCase().includes("channel"))) {
          headerIdx = i;
          break;
        }
      }
      if (headerIdx === -1) {
        uploadBtn.textContent = "❌ No header row found";
        return;
      }

      const headers = allRows[headerIdx].map(h => String(h).trim());
      console.log("[Popup] Headers at row", headerIdx, ":", headers.join(" | "));

      // Find column indices
      const orderIdIdx = headers.findIndex(h => /order\s*id/i.test(h));
      const channelIdx = headers.findIndex(h => /^channel$/i.test(h));
      const finalResIdx = headers.findIndex(h => /final\s*resolution$/i.test(h));

      if (orderIdIdx === -1) {
        uploadBtn.textContent = "❌ No 'Order ID' column found";
        return;
      }

      console.log("[Popup] Columns - OrderID:", orderIdIdx, "Channel:", channelIdx, "FinalRes:", finalResIdx);

      // Extract data rows (after header), keeping only essential fields
      const slimData = [];
      for (let i = headerIdx + 1; i < allRows.length; i++) {
        const row = allRows[i];
        if (!row || row.length < 3) continue;
        const orderId = String(row[orderIdIdx] || "").trim();
        if (!orderId || orderId.length < 5) continue; // Skip empty/invalid
        slimData.push({
          o: orderId,
          c: channelIdx >= 0 ? String(row[channelIdx] || "").trim() : "",
          r: finalResIdx >= 0 ? String(row[finalResIdx] || "").trim() : ""
        });
      }

      await chrome.storage.local.set({ safetData: slimData, safetUploadedAt: new Date().toISOString(), safetFileName: file.name });
      uploadBtn.textContent = `✅ ${slimData.length} orders loaded`;
      console.log("[Popup] SAFET data loaded:", slimData.length, "rows");
    } catch (err) {
      uploadBtn.textContent = "❌ " + err.message;
      console.error("[Popup] SAFET upload error:", err);
    }
  });

  // Show current SAFET data status
  const { safetData, safetUploadedAt, safetFileName } = await chrome.storage.local.get(["safetData", "safetUploadedAt", "safetFileName"]);
  if (safetData && safetData.length > 0) {
    const ago = safetUploadedAt ? timeAgo(safetUploadedAt) : "";
    uploadBtn.textContent = `📂 SAFET: ${safetData.length} rows (${ago})`;
  }
}

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

    // ✨ Get bucketName from classified category
    const cls = finding.classification || {};
    const category = cls.status === "CLASSIFIED" ? cls.category :
                     (cls.status === "AMBIGUOUS" ? cls.top2?.[0]?.category : null);
    const bucketForResolve = category?.bucketName || "Fees Charged in Error";

    if (!confirm(`Auto-resolve as OUT OF SCOPE?\n\nBucket: "${bucketForResolve}"\nSub Bucket: "Issue Not handled by SR"\n\n1. Post redirect comment\n2. Auto-submit comment\n3. Apply label: "${labelName}"\n4. Fill & Submit Resolve Modal\n\nProceed?`)) return;

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
          bucket: bucketForResolve,
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

  if (actionType === "out_of_scope_az") {
    const template = rulesData.azClaimsComment || "If your issue is about A-Z claims, please note that this is out of scope for Seller Reimbursement team. Please reach out to concerned POC. We are unaware of the same.";
    const labelName = rulesData.labels?.outOfScope || "Issue Not Handled by SR";

    if (!confirm(`Auto-resolve as OUT OF SCOPE (A-Z Claims)?\n\n1. Post A-Z comment\n2. Apply label: "${labelName}"\n3. Resolve\n\nProceed?`)) return;

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
          summary: "out of scope - A-Z claims",
          bucket: "General Enquiry",
          claimStatus: "Denied",
          subBucket: "Issue Not handled by SR",
          reimbursementAmount: "0"
        }
      }
    });
    btn.textContent = res.success ? "✅ Resolved (A-Z Out of Scope)" : "⚠️ " + (res.message || res.error);
    if (!res.success) btn.disabled = false;
    return;
  }

  if (actionType === "wiki_not_followed") {
    const commentText = generateWikiNotFollowedComment(finding);
    const labelName = rulesData.labels?.wikiNotFollowed || "Wiki/Template not followed";

    // Get bucketName from classified category
    const cls = finding.classification || {};
    const category = cls.status === "CLASSIFIED" ? cls.category :
                     (cls.status === "AMBIGUOUS" ? cls.top2?.[0]?.category : null);
    const bucketForResolve = category?.bucketName || "General Enquiry";
    const categoryName = category?.name || "Unknown";

    if (!confirm(`Auto-resolve as WIKI NOT FOLLOWED?\n\nCategory: ${categoryName}\nBucket: "${bucketForResolve}"\nSub Bucket: "Invalid (Incomplete Information)"\n\n1. Post format-request comment\n2. Auto-submit comment\n3. Apply label: "${labelName}"\n4. Fill & Submit Resolve Modal\n\nNO assignment.\n\nProceed?`)) return;

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
          bucket: bucketForResolve,
          claimStatus: "Denied",
          subBucket: "Invalid (Incomplete Information)",
          reimbursementAmount: "0"
        }
      }
    });
    btn.textContent = res.success ? `✅ Resolved (${categoryName})` : "⚠️ " + (res.message || res.error);
    if (!res.success) btn.disabled = false;
    return;
  }

  if (actionType === "yoda_lookup") {
    const orderIds = extractOrderIdsFromText(finding.rawDescription || "");
    if (orderIds.length === 0) {
      btn.textContent = "❌ No Order IDs found";
      return;
    }
    btn.textContent = `⏳ Yoda lookup started...`; btn.disabled = true;

    // Start lookup in background — it will save results to storage
    // Popup may close before it finishes, that's OK
    chrome.runtime.sendMessage({ action: "yodaLookupBg", orderIds, issueId });

    // Update finding to show lookup is in progress
    const { findings: allFindings = {} } = await chrome.storage.local.get(["findings"]);
    if (allFindings[issueId]) {
      allFindings[issueId].efYodaStatus = "in_progress";
      await chrome.storage.local.set({ findings: allFindings });
    }

    btn.textContent = "⏳ Running in background... reopen popup to see result";
    return;
  }

  if (actionType === "assign_ef") {
    const assignee = btn.dataset.assignee;
    if (!confirm(`Assign this EF ticket to ${assignee}?`)) return;
    btn.textContent = "⏳ Assigning..."; btn.disabled = true;
    const res = await chrome.runtime.sendMessage({ action: "assignIssueBg", issueId, username: assignee });
    btn.textContent = res.success ? "✅ Assigned" : "❌ " + (res.error || "Failed");
    if (!res.success) btn.disabled = false;
    return;
  }

  if (actionType === "manual_check") {
    chrome.notifications.create("manual-check-" + issueId, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "⚠️ Manual Check Required",
      message: "Order IDs are in an attachment. Please open the SIM, download the attachment, check the Order IDs manually, and assign to the correct owner."
    });
    return;
  }
}

function generateWikiNotFollowedComment(finding) {
  const cls = finding.classification || {};
  const category = cls.status === "CLASSIFIED" ? cls.category : cls.top2?.[0]?.category;

  // Use EF-specific template for EF channel tickets
  if (category?.isEFChannel && rulesData.efWikiNotFollowedCommentTemplate) {
    return rulesData.efWikiNotFollowedCommentTemplate;
  }

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

  const action = decideAction(cls, fc, f);

  const missingLine = fc.missing.length > 0
    ? `<div class="miss">⚠️ Missing: ${fc.missing.join(", ")}</div>`
    : (fc.present.length > 0 ? `<div class="ok-line">✅ All mandatory fields present</div>` : "");
  const optionalLine = fc.optionalMissing && fc.optionalMissing.length > 0
    ? `<div class="opt">💡 Recommended: ${fc.optionalMissing.join(", ")}</div>` : "";

  // EF Channel info line
  let efLine = "";
  if (cls.category?.isEFChannel) {
    const yodaData = f.efYodaData;
    if (yodaData) {
      efLine = `<div class="ef-info">📊 Yoda: Channel=${yodaData.majorityChannel || "?"} | Resolution=${yodaData.majorityResolution || "?"} | → ${yodaData.assignee || "?"}</div>`;
    } else {
      const orderCount = extractOrderIdsFromText(f.rawDescription || "").length;
      efLine = `<div class="ef-info">📋 EF Channel (${cls.category.efSubType || "?"}) • ${orderCount} order(s) found • Needs Yoda lookup</div>`;
    }
  }

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
    ${efLine}
    ${evidenceLine}
    ${actionBtnHtml ? `<div class="card-actions">${actionBtnHtml}</div>` : ""}
  `;
  return div;
}

function decideAction(cls, fc, finding) {
  if (cls.status === "REDIRECT" && cls.category?.useOutOfScopeTemplate) {
    return { type: "out_of_scope", label: "🚫 Auto-Resolve Out of Scope", cssClass: "oos-btn" };
  }
  if (cls.status === "REDIRECT" && cls.category?.useAZTemplate) {
    return { type: "out_of_scope_az", label: "🚫 Auto-Resolve Out of Scope (A-Z Claims)", cssClass: "oos-btn" };
  }
  if (cls.status === "AMBIGUOUS" && cls.top2?.length >= 2) {
    const bothOutOfScope = cls.top2.every(t => t.category?.useOutOfScopeTemplate);
    if (bothOutOfScope) {
      return { type: "out_of_scope", label: "🚫 Auto-Resolve Out of Scope", cssClass: "oos-btn" };
    }
  }

  // EF Channel handling
  if (cls.category?.isEFChannel) {
    // SP-SEED exception: valid with just MID + Order ID, skip field check
    const isSPSeed = /sp[-_\s]?seed/i.test(finding?.title || "") || /sp[-_\s]?seed/i.test(finding?.rawDescription || "");

    if (!isSPSeed) {
      // Check if Order IDs are "Attached" — require manual check (highest priority)
      const orderIdValue = fc.values?.["Order ID"] || "";
      const rawDesc = finding?.rawDescription || "";
      const isAttached = /^(attached|see\s*attach|in\s*attach|refer\s*attach|check\s*attach|file\s*attach)/i.test(orderIdValue.trim()) ||
        /order\s*ids?\s*[:\-=]?\s*(attached|see\s*attach|in\s*attach)/i.test(rawDesc);
      if (isAttached) {
        return { type: "manual_check", label: "⚠️ Order IDs in attachment — Check manually", cssClass: "wiki-btn" };
      }

      // Check mandatory fields — if missing, show wiki not followed
      if (fc.missing && fc.missing.length > 0) {
        return { type: "wiki_not_followed", label: "🏷️ Resolve - Wiki Not Followed (EF)", cssClass: "wiki-btn" };
      }
    }

    const yodaData = finding?.efYodaData;
    if (yodaData && yodaData.assignee) {
      return { type: "assign_ef", label: `🎯 Assign to ${yodaData.assignee} (EF: ${yodaData.majorityChannel || "?"})`, cssClass: "assign-btn", assignee: yodaData.assignee };
    }
    const yodaStatus = finding?.efYodaStatus;
    if (yodaStatus === "in_progress") {
      return { type: "yoda_lookup", label: "⏳ Yoda lookup in progress...", cssClass: "yoda-btn" };
    }
    if (yodaStatus === "error") {
      return { type: "yoda_lookup", label: `❌ Yoda failed: ${finding?.efYodaError || "retry?"} — Click to retry`, cssClass: "yoda-btn" };
    }
    // No Yoda data yet — show lookup button
    return { type: "yoda_lookup", label: "🔍 Lookup SAFET Data (EF Channel)", cssClass: "yoda-btn" };
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
function extractOrderIdsFromText(text) {
  const re = /\b\d{3}-\d{7}-\d{7}\b/g;
  const matches = (text || "").match(re) || [];
  return [...new Set(matches)];
}