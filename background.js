const POLL_INTERVAL_MIN = 5;
const DASHBOARD_ID = "2884899d-54a7-409b-9e88-b7ca4b0416ba";
const SEARCH_URL = `https://issues.amazon.com/issues/search?q=assignee%3A(nobody)+in%3A(${DASHBOARD_ID})+status%3A(Open)+folderType%3A(Default)&sort=score+desc`;
const MAX_HISTORY = 100;

let rulesCache = null;
async function loadRules() {
  if (rulesCache) return rulesCache;
  const res = await fetch(chrome.runtime.getURL("rules.json") + "?t=" + Date.now());
  rulesCache = await res.json();
  return rulesCache;
}

chrome.runtime.onInstalled.addListener(() => {
  rulesCache = null;
  chrome.alarms.create("pollUnassigned", { periodInMinutes: POLL_INTERVAL_MIN });
  chrome.storage.local.set({ findings: {}, previousQueue: [], scanHistory: [], lastScanAt: null });
  console.log("[FBA Monitor BG v8.7] Installed.");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "pollUnassigned") {
    // Check if system is active before scanning
    const state = await chrome.idle.queryState(60); // 60 seconds threshold
    if (state === "locked") {
      console.log("[FBA Monitor BG] System locked — skipping scan");
      return;
    }
    await runScan();
    // After scan, run auto-mode if enabled
    await runAutoMode();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "manualScan") { runScan().then(r => sendResponse(r)); return true; }
  if (msg.action === "assignIssueBg") {
    assignIssueBg(msg.issueId, msg.username).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.action === "fullAutoResolveBg") {
    fullAutoResolveBg(msg.issueId, msg.options).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.action === "yodaLookupBg") {
    // Start Yoda lookup — save results to findings when done
    const issueId = msg.issueId;
    performYodaLookupBg(msg.orderIds).then(async (result) => {
      if (issueId && result.success && result.analysis) {
        const { findings = {} } = await chrome.storage.local.get(["findings"]);
        if (findings[issueId]) {
          findings[issueId].efYodaData = result.analysis;
          findings[issueId].efYodaStatus = "done";
          await chrome.storage.local.set({ findings });
          console.log(`[FBA Monitor BG] Yoda lookup complete for ${issueId}: ${result.analysis.assignee}`);
        }
      } else if (issueId) {
        const { findings = {} } = await chrome.storage.local.get(["findings"]);
        if (findings[issueId]) {
          findings[issueId].efYodaStatus = "error";
          findings[issueId].efYodaError = result.error || "Unknown error";
          await chrome.storage.local.set({ findings });
        }
      }
      sendResponse(result);
    }).catch(e => {
      sendResponse({ success: false, error: e.message });
    });
    return true;
  }
  if (msg.action === "setAutoMode") {
    chrome.storage.local.set({ autoMode: msg.enabled });
    sendResponse({ success: true, autoMode: msg.enabled });
    return true;
  }
  if (msg.action === "getAutoMode") {
    chrome.storage.local.get(["autoMode"]).then(s => sendResponse({ autoMode: s.autoMode || false }));
    return true;
  }
});

async function runScan() {
  console.log("[FBA Monitor BG v8.7] Starting scan...");
  try {
    // Check idle state even for manual scans
    const idleState = await chrome.idle.queryState(60);
    if (idleState === "locked") {
      return { success: false, error: "System is locked — scan skipped to prevent incorrect results" };
    }

    const tab = await ensureSearchTab();
    if (!tab) return { success: false, error: "No SIM tab available" };

    // Reload the page to get fresh search results
    await chrome.tabs.update(tab.id, { url: SEARCH_URL });
    await waitForTabComplete(tab.id, 15000);
    await sleep(2000); // Extra wait for SIM page to fully render

    const ready = await waitForContentScript(tab.id, 15000);
    if (!ready) return { success: false, error: "Content script not ready. Reload the tab." };
    const response = await sendMessageWithRetry(tab.id, { action: "performScan", dashboardId: DASHBOARD_ID }, 3);
    if (!response || !response.success) return { success: false, error: response?.error || "Scan failed" };

    // Validate scan quality — reject if descriptions look empty/broken
    const issues = response.issues || [];
    if (issues.length > 0) {
      const avgDescLen = issues.reduce((sum, i) => sum + (i.description || "").length, 0) / issues.length;
      if (avgDescLen < 30) {
        console.warn("[FBA Monitor BG] Scan rejected — descriptions too short (avg " + Math.round(avgDescLen) + " chars). Tab may not be rendering properly.");
        return { success: false, error: "Scan data unreliable (page not rendering). Try again when system is active." };
      }
    }

    const now = new Date().toISOString();
    const rules = await loadRules();
    const classifier = new IssueClassifierWrapper(rules);
    const store = await chrome.storage.local.get(["findings", "previousQueue", "scanHistory"]);
    const findings = store.findings || {};
    const previousQueueSet = new Set(store.previousQueue || []);
    const scanHistory = store.scanHistory || [];
    const currentQueueUuids = (response.issues || []).map(i => i.issueId);
    const currentQueueSet = new Set(currentQueueUuids);
    const newUuids = currentQueueUuids.filter(u => !previousQueueSet.has(u));
    const stillUuids = currentQueueUuids.filter(u => previousQueueSet.has(u));
    const resolvedUuids = [...previousQueueSet].filter(u => !currentQueueSet.has(u));

    for (const issue of (response.issues || [])) {
      const textToClassify = (issue.title || "") + "\n" + (issue.srTag || "") + "\n" + (issue.description || "");
      const classification = classifier.classify(textToClassify);
      let fieldCheck = null;
      const cat = classification.status === "CLASSIFIED" ? classification.category :
                  (classification.status === "AMBIGUOUS" ? classification.top2?.[0]?.category : null);
      if (cat) {
        fieldCheck = classifier.checkMandatoryFields(issue.description, cat, issue.attachments || [], issue.externalLinks || []);
      }
      const existing = findings[issue.issueId];
      findings[issue.issueId] = {
        issueId: issue.issueId, title: issue.title, srTag: issue.srTag, creator: issue.creator,
        firstSeenAt: existing?.firstSeenAt || now, lastSeenAt: now, lastScannedAt: now,
        status: "active", isNewInLastScan: !previousQueueSet.has(issue.issueId),
        classification, fieldCheck,
        attachments: issue.attachments || [], externalLinks: issue.externalLinks || [],
        rawDescription: (issue.description || "").slice(0, 5000)
      };
    }
    for (const uuid of resolvedUuids) {
      if (findings[uuid]) { findings[uuid].status = "resolved"; findings[uuid].resolvedAt = now; findings[uuid].isNewInLastScan = false; }
    }
    for (const uuid of stillUuids) {
      if (findings[uuid]) findings[uuid].isNewInLastScan = false;
    }
    scanHistory.push({ scanAt: now, activeCount: currentQueueUuids.length, newCount: newUuids.length, resolvedCount: resolvedUuids.length });
    if (scanHistory.length > MAX_HISTORY) scanHistory.shift();
    await chrome.storage.local.set({ findings, previousQueue: currentQueueUuids, scanHistory, lastScanAt: now });

    const activeCount = currentQueueUuids.length;
    chrome.action.setBadgeText({ text: activeCount > 0 ? String(activeCount) : "" });
    chrome.action.setBadgeBackgroundColor({ color: newUuids.length > 0 ? "#d13212" : "#146eb4" });
    if (newUuids.length > 0) {
      try {
        chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png",
          title: `FBA Monitor: ${newUuids.length} NEW`, message: `${activeCount} active. ${resolvedUuids.length} resolved.` });
      } catch (e) {}
    }

    // Check for EF tickets with "Order IDs: Attached" — notify to check manually
    const manualCheckTickets = [];
    for (const [id, f] of Object.entries(findings)) {
      if (f.status !== "active") continue;
      if (!f.classification?.category?.isEFChannel) continue;
      const desc = (f.rawDescription || "").toLowerCase();
      const orderVal = f.fieldCheck?.values?.["Order ID"] || "";
      if (/^(attached|see\s*attach|in\s*attach)/i.test(orderVal.trim()) || /order\s*ids?\s*[:\-=]?\s*(attached|see\s*attach)/i.test(desc)) {
        manualCheckTickets.push(f.title || id);
      }
    }
    if (manualCheckTickets.length > 0) {
      try {
        chrome.notifications.create("manual-check-scan", { type: "basic", iconUrl: "icons/icon128.png",
          title: `⚠️ Manual Check Required (${manualCheckTickets.length})`,
          message: `Order IDs are in attachment for: ${manualCheckTickets[0].substring(0, 80)}${manualCheckTickets.length > 1 ? " + " + (manualCheckTickets.length - 1) + " more" : ""}` });
      } catch (e) {}
    }

    return { success: true, newCount: newUuids.length, activeCount, resolvedCount: resolvedUuids.length };
  } catch (err) {
    console.error("[FBA Monitor BG v8.7] Scan failed:", err);
    return { success: false, error: err.message };
  }
}

async function assignIssueBg(issueId, username) {
  const tab = await navigateToIssue(issueId);
  if (!tab) return { success: false, error: "Cannot open SIM tab" };
  const ready = await waitForContentScript(tab.id, 10000);
  if (!ready) return { success: false, error: "Content script not ready" };
  return await chrome.tabs.sendMessage(tab.id, { action: "assignIssue", issueId, username });
}

async function fullAutoResolveBg(issueId, options) {
  const tab = await navigateToIssue(issueId);
  if (!tab) return { success: false, error: "Cannot open SIM tab" };
  const ready = await waitForContentScript(tab.id, 10000);
  if (!ready) return { success: false, error: "Content script not ready" };
  return await chrome.tabs.sendMessage(tab.id, { action: "fullAutoResolve", issueId, options });
}

async function navigateToIssue(issueId) {
  const tabs = await chrome.tabs.query({ url: "https://issues.amazon.com/*" });
  let tab = tabs[0];
  const targetUrl = `https://issues.amazon.com/issues/search?q=assignee%3A(nobody)+in%3A(${DASHBOARD_ID})+status%3A(Open)+folderType%3A(Default)&sort=score+desc&selectedDocument=${issueId}`;
  if (!tab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
    await waitForTabComplete(tab.id, 15000);
  } else {
    await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    await waitForTabComplete(tab.id, 10000);
  }
  await sleep(2500);
  return tab;
}

async function ensureSearchTab() {
  // Strategy: Use a dedicated small window for scanning.
  // Chrome throttles minimized windows, so we use a tiny normal window
  // positioned at the bottom-right corner of the screen.

  const searchTabs = await chrome.tabs.query({ url: "https://issues.amazon.com/issues/search*" });

  if (searchTabs.length > 0) {
    const tab = searchTabs[0];
    // Ensure it's the active tab in its window
    await chrome.tabs.update(tab.id, { active: true });
    // Make sure the window is in "normal" state (not minimized)
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") {
      // Restore it as a small window in the corner
      await chrome.windows.update(tab.windowId, {
        state: "normal",
        width: 400,
        height: 300,
        left: screen?.availWidth ? screen.availWidth - 420 : 1500,
        top: screen?.availHeight ? screen.availHeight - 320 : 800,
        focused: false
      });
    }
    await sleep(500);
    return tab;
  }

  // No existing SIM search tab — check for any issues.amazon.com tab
  const anyTabs = await chrome.tabs.query({ url: "https://issues.amazon.com/*" });
  if (anyTabs.length > 0) {
    const tab = anyTabs[0];
    await chrome.tabs.update(tab.id, { url: SEARCH_URL, active: true });
    await waitForTabComplete(tab.id, 10000);
    // Move to small corner window
    const win = await chrome.windows.get(tab.windowId);
    if (win.type === "normal" && (await chrome.tabs.query({ windowId: win.id })).length > 1) {
      // Tab is in user's main window with other tabs — move it out
      await chrome.windows.create({
        tabId: tab.id,
        state: "normal",
        width: 400, height: 300,
        left: 1500, top: 800,
        focused: false
      });
      await sleep(500);
    }
    return await chrome.tabs.get(tab.id);
  }

  // No SIM tab at all — create in a small corner window
  const newWindow = await chrome.windows.create({
    url: SEARCH_URL,
    state: "normal",
    width: 400,
    height: 300,
    left: 1500,
    top: 800,
    focused: false
  });
  const tab = newWindow.tabs[0];
  await waitForTabComplete(tab.id, 15000);
  return await chrome.tabs.get(tab.id);
}

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeout);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete" && !done) {
        done = true; clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener); resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForContentScript(tabId, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { action: "ping" });
      if (pong && pong.pong) return true;
    } catch (e) {}
    await sleep(500);
  }
  return false;
}

async function sendMessageWithRetry(tabId, msg, maxRetries) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await chrome.tabs.sendMessage(tabId, msg); }
    catch (e) { if (i === maxRetries - 1) throw e; await sleep(1000); }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class IssueClassifierWrapper {
  constructor(rules) { this.rules = rules; }
  classify(text) {
    const normalized = (text || "").toLowerCase();

    // ═══ PRIORITY CHECK: Weight/Dimension/Fees → always Out of Scope ═══
    const feesOverride = this.checkFeesOverride(normalized);
    if (feesOverride) return feesOverride;

    // ═══ PRIORITY CHECK #2: EF Channel detection ═══
    const efResult = this.checkEFChannel(normalized);
    if (efResult) return efResult;

    const scores = this.rules.categories.filter(c => !c.isEFChannel).map(cat => this.scoreCategory(cat, normalized));
    scores.sort((a, b) => b.score - a.score);
    const top = scores[0], second = scores[1];
    if (top.category.action === "REDIRECT" && top.score >= 30) {
      return { status: "REDIRECT", category: top.category, score: top.score, message: `${top.category.parent} → ${top.category.redirectTo || 'external team'}` };
    }
    if (second && (top.score - second.score) < this.rules.ambiguityThreshold) {
      return { status: "AMBIGUOUS",
        top2: [{ category: top.category, score: top.score, signals: top.signals }, { category: second.category, score: second.score, signals: second.signals }],
        message: `Ambiguous: ${top.category.name} (${top.score}) vs ${second.category.name} (${second.score})` };
    }
    if (top.score < this.rules.minConfidenceScore) {
      return { status: "UNCLASSIFIABLE", topGuess: { category: top.category, score: top.score, signals: top.signals }, message: "Below threshold." };
    }
    return { status: "CLASSIFIED", category: top.category, score: top.score, signals: top.signals };
  }
  checkEFChannel(text) {
    // Must have SAFE-T signal
    if (!(/\bsafe-?t\b/i.test(text))) return null;

    // Check for EF title patterns (strongest signal — always triggers EF)
    const titlePatterns = this.rules.efTitlePatterns || [];
    let hasTitlePattern = false;
    for (const pattern of titlePatterns) {
      const flex = this.esc(pattern).replace(/\s+/g, "\\s+");
      if (new RegExp(flex, "i").test(text)) { hasTitlePattern = true; break; }
    }

    // Check for EF channel keywords
    const efKeywords = this.rules.efChannelKeywords || [];
    let hasEFSignal = false;
    for (const kw of efKeywords) {
      const flex = this.esc(kw).replace(/\s+/g, "\\s+");
      if (new RegExp(`\\b${flex}\\b`, "i").test(text)) { hasEFSignal = true; break; }
    }

    // Need EITHER a title pattern OR a channel keyword (plus SAFE-T which we already checked)
    if (!hasTitlePattern && !hasEFSignal) return null;

    const efCategories = (this.rules.categories || []).filter(c => c.isEFChannel);
    if (efCategories.length === 0) return null;

    let bestCat = null, bestScore = 0, bestSignals = [];
    for (const cat of efCategories) {
      const result = this.scoreCategory(cat, text);
      if (result.score > bestScore) { bestScore = result.score; bestCat = cat; bestSignals = result.signals; }
    }
    if (!bestCat || bestScore < 20) {
      bestCat = efCategories.find(c => c.efSubType === "denial") || efCategories[0];
      bestSignals = ["EF Channel + SAFE-T detected (default to denial sub-type)"];
    }
    return { status: "CLASSIFIED", category: bestCat, score: bestScore, signals: bestSignals, isEFChannel: true,
      message: `EF Channel (${bestCat.efSubType}) — requires Yoda lookup for assignment` };
  }
  checkFeesOverride(text) {
    const keywords = this.rules.feesOverrideKeywords || [];
    const matched = [];
    const lines = text.split(/\n/);
    // Lines that look like template selection prompts (contain multiple category options)
    const templateLineIndicators = ["select only one", "mfi /removal", "mfi/removal", "warehouse lost /fees", "removal order related"];
    // If the text has strong SAFE-T + EF signals, don't trigger fees override for clawback/claw back
    const hasSafetSignal = /\bsafe-?t\b/i.test(text);
    const hasEFSignal = /\b(easyship|easy\s*ship|seller\s*flex|sellerflex|mfn|self\s*ship|selfship)\b/i.test(text);
    const isEFContext = hasSafetSignal && hasEFSignal;

    for (const kw of keywords) {
      // Skip clawback/claw back keywords when in EF SAFE-T context
      if (isEFContext && (kw === "clawback" || kw === "claw back")) continue;

      const flex = this.esc(kw).replace(/\s+/g, "\\s+");
      const kwRe = new RegExp(`\\b${flex}\\b`, "i");
      // Check if keyword appears but ONLY on template selection lines
      let foundOnRealLine = false;
      for (const line of lines) {
        if (!kwRe.test(line)) continue;
        // Skip if this line looks like a template dropdown/selection prompt
        const isTemplateLine = templateLineIndicators.some(ind => line.toLowerCase().includes(ind));
        if (!isTemplateLine) { foundOnRealLine = true; break; }
      }
      if (foundOnRealLine) matched.push(kw);
    }
    if (matched.length === 0) return null;
    const category = this.rules.feesOverrideCategory || this.rules.categories.find(c => c.id === "weight_dimension_out_of_scope");
    return {
      status: "REDIRECT",
      category: category,
      score: 999,
      signals: matched.map(kw => `Fees override keyword "${kw}"`),
      message: `Fees/Weight/Dimension detected → Out of Scope (override). Matched: ${matched.join(", ")}`
    };
  }
  scoreCategory(cat, text) {
    let score = 0; const signals = [];
    if (cat.primaryIdRegex && new RegExp(cat.primaryIdRegex, "i").test(text)) {
      score += 50; signals.push(`Primary ID "${cat.primaryIdField}" (+50)`);
    }
    for (const kw of cat.exclusiveKeywords || []) {
      const flex = this.esc(kw).replace(/\s+/g, "\\s+");
      if (new RegExp(`\\b${flex}\\b`, "i").test(text)) { score += 15; signals.push(`ExclKw "${kw}" (+15)`); }
    }
    for (const kw of cat.keywords || []) {
      const flex = this.esc(kw).replace(/\s+/g, "\\s+");
      if (new RegExp(`\\b${flex}\\b`, "i").test(text)) { score += 10; signals.push(`Kw "${kw}" (+10)`); }
    }
    for (const field of (cat.mandatoryFields || []).concat(cat.optionalFields || [])) {
      const aliases = this.rules.fieldAliases[field] || [field.toLowerCase()];
      for (const a of aliases) {
        const flex = this.esc(a).replace(/\s+/g, "\\s+");
        if (new RegExp(`\\b${flex}\\b`, "i").test(text)) { score += 5; signals.push(`Field "${field}" (+5)`); break; }
      }
    }
    return { category: cat, score, signals };
  }
  checkMandatoryFields(text, category, attachments = [], externalLinks = []) {
    const result = { present: [], missing: [], optionalPresent: [], optionalMissing: [], values: {}, evidence: {} };
    const lines = (text || "").split(/\n/);
    const checkField = (field) => {
      const aliases = this.rules.fieldAliases[field] || [field.toLowerCase()];
      let found = false, value = null, source = null;
      for (const alias of aliases) {
        const flexAlias = this.esc(alias).replace(/\s+/g, "\\s+");
        const labelRe = new RegExp(`^\\s*(?:[\\dA-Za-z]+\\s*[.:\\-]\\s*)?${flexAlias}(?:\\s+[\\w/()\\[\\]?.]+){0,10}\\s*[:\\-=\\u2013\\u2014]\\s*(.*)$`, "i");
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(labelRe);
          if (!m) continue;
          const inlineValue = (m[1] || "").trim();
          if (inlineValue && !this.isPlaceholder(inlineValue)) { found = true; value = inlineValue; source = "text_label"; break; }
          for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
            const next = lines[j].trim();
            if (!next) continue;
            if (this.looksLikeLabel(next)) break;
            if (this.isPlaceholder(next)) continue;
            found = true; value = next; source = "text_label_multiline"; break;
          }
          if (found) break;
        }
        if (found) break;
      }
      if (!found) {
        const evType = this.mapFieldToAttachmentType(field);
        if (evType) {
          const match = attachments.find(a => a.type === evType);
          if (match) { found = true; value = `[Attachment: ${match.filename}]`; source = "attachment"; }
        }
      }
      if (!found) {
        const linkTypes = this.mapFieldToLinkTypes(field);
        if (linkTypes.length > 0) {
          const match = externalLinks.find(l => linkTypes.includes(l.type));
          if (match) { found = true; value = `[Link: ${match.type}]`; source = "external_link"; }
        }
      }
      return { found, value, source };
    };
    for (const field of category.mandatoryFields || []) {
      const r = checkField(field);
      if (r.found) { result.present.push(field); result.values[field] = r.value; result.evidence[field] = r.source; }
      else result.missing.push(field);
    }
    for (const field of category.optionalFields || []) {
      const r = checkField(field);
      if (r.found) { result.optionalPresent.push(field); result.values[field] = r.value; result.evidence[field] = r.source; }
      else result.optionalMissing.push(field);
    }
    return result;
  }
  looksLikeLabel(line) {
    return /^\d+\s*[.:\-]\s+[A-Z]/i.test(line) || /^[A-Za-z][A-Za-z0-9 _/\-]{2,40}\s*[:\-=\u2013\u2014]\s*/i.test(line);
  }
  mapFieldToAttachmentType(field) {
    const map = { "Unboxing Video": "video", "Product Images": "image", "POD": "pod", "EPOD": "pod", "Invoice": "invoice", "STN": "pod" };
    return map[field] || null;
  }
  mapFieldToLinkTypes(field) {
    const map = { "Unboxing Video": ["gdrive", "youtube"], "Product Images": ["gdrive", "amazon_attachment"], "POD": ["amazon_attachment"], "Invoice": ["gdrive", "amazon_attachment"] };
    return map[field] || [];
  }
  isPlaceholder(v) {
    const s = (v || "").trim().toLowerCase();
    return s === "" || s === "n/a" || s === "na" || s === "tbd" || s === "-" || s === "n" || s === "no" || s === "none" || s === "null";
  }
  esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
}

// ═══════════════════════════════════════════════════════════════
// EF CHANNEL — YODA DASHBOARD LOOKUP
// ═══════════════════════════════════════════════════════════════

// Extract order IDs from ticket text (format: 123-1234567-1234567)
function extractOrderIds(text) {
  const re = /\b\d{3}-\d{7}-\d{7}\b/g;
  const matches = (text || "").match(re) || [];
  return [...new Set(matches)]; // deduplicate
}

// EF Channel Lookup: Search the uploaded SAFET Excel data for matching Order IDs
async function performYodaLookupBg(orderIds) {
  if (!orderIds || orderIds.length === 0) {
    return { success: false, error: "No order IDs provided" };
  }
  console.log("[FBA Monitor BG] SAFET lookup for", orderIds.length, "orders");
  const { safetData, safetUploadedAt } = await chrome.storage.local.get(["safetData", "safetUploadedAt"]);
  if (!safetData || safetData.length === 0) {
    return { success: false, error: "No SAFET data uploaded. Click Upload SAFET Excel in the popup first." };
  }
  console.log("[FBA Monitor BG] Searching", safetData.length, "SAFET rows");
  const matchedRows = safetData.filter(row => {
    const rowOid = String(row.o || "").trim();
    return orderIds.some(id => rowOid.includes(id));
  });
  console.log("[FBA Monitor BG] Matched", matchedRows.length, "rows");
  const analysis = { totalRows: matchedRows.length, majorityChannel: null, majorityResolution: null, channelCounts: {}, resolutionCounts: {}, isMFN: false, assignee: null };
  if (matchedRows.length === 0) { analysis.assignee = "mansilko"; return { success: true, results: { rows: [] }, analysis }; }
  for (const row of matchedRows) {
    const ch = (row.c || "").toLowerCase();
    const res = (row.r || "").toUpperCase();
    if (ch) analysis.channelCounts[ch] = (analysis.channelCounts[ch] || 0) + 1;
    if (res) analysis.resolutionCounts[res] = (analysis.resolutionCounts[res] || 0) + 1;
  }
  let maxCh = 0; for (const [k, v] of Object.entries(analysis.channelCounts)) { if (v > maxCh) { maxCh = v; analysis.majorityChannel = k; } }
  let maxRes = 0; for (const [k, v] of Object.entries(analysis.resolutionCounts)) { if (v > maxRes) { maxRes = v; analysis.majorityResolution = k; } }
  analysis.isMFN = analysis.majorityChannel ? analysis.majorityChannel.includes("mfn") : false;
  const rules = await loadRules();
  const mapping = rules.efReasonCodeMapping || {};
  if (analysis.isMFN) { analysis.assignee = mapping["_MFN_"] || "dhrubora"; }
  else if (analysis.majorityResolution) {
    const code = analysis.majorityResolution;
    for (const [k, v] of Object.entries(mapping)) { if (!k.startsWith("_") && code.includes(k)) { analysis.assignee = v; break; } }
    if (!analysis.assignee) analysis.assignee = mapping["_DEFAULT_"] || "mansilko";
  } else { analysis.assignee = mapping["_DEFAULT_"] || "mansilko"; }
  console.log("[FBA Monitor BG] SAFET result:", JSON.stringify(analysis));
  return { success: true, results: { rows: matchedRows.length }, analysis };
}

// ═══════════════════════════════════════════════════════════════
// AUTO-MODE: Fully autonomous processing
// ═══════════════════════════════════════════════════════════════

async function runAutoMode() {
  const store = await chrome.storage.local.get(["autoMode", "findings"]);
  if (!store.autoMode) return;

  const findings = store.findings || {};
  const rules = await loadRules();
  const classifier = new IssueClassifierWrapper(rules);

  for (const [issueId, finding] of Object.entries(findings)) {
    if (finding.status !== "active") continue;
    if (finding.autoProcessed) continue; // Already processed

    const cls = finding.classification;
    if (!cls) continue;

    try {
      // ── OUT OF SCOPE (fees/weight) → auto-resolve ──
      if (cls.status === "REDIRECT" && cls.category?.useOutOfScopeTemplate) {
        console.log(`[AutoMode] Resolving out-of-scope: ${issueId}`);
        const result = await fullAutoResolveBg(issueId, {
          comment: rules.outOfScopeCommentTemplate,
          label: rules.labels.outOfScope,
          bucket: cls.category.bucketName || "Fees Charged in Error",
          subBucket: "Issue Not handled by SR",
          claimStatus: "Denied",
          summary: "out of scope",
          reimbursementAmount: "0"
        });
        finding.autoProcessed = true;
        finding.autoAction = "resolved_out_of_scope";
        finding.autoResult = result;
        continue;
      }

      // ── EF CHANNEL → Yoda lookup then assign ──
      if (cls.category?.isEFChannel) {
        console.log(`[AutoMode] EF Channel detected: ${issueId}`);
        const orderIds = extractOrderIds(finding.rawDescription);
        if (orderIds.length === 0) {
          finding.autoProcessed = true;
          finding.autoAction = "ef_no_order_ids";
          continue;
        }

        // Check mandatory fields first
        const fieldCheck = classifier.checkMandatoryFields(finding.rawDescription, cls.category, finding.attachments || [], finding.externalLinks || []);
        if (fieldCheck.missing.length > 0) {
          // Wiki not followed
          console.log(`[AutoMode] EF wiki not followed: ${issueId}, missing: ${fieldCheck.missing.join(", ")}`);
          const comment = buildWikiNotFollowedComment(rules, cls.category, fieldCheck, finding.title);
          const result = await fullAutoResolveBg(issueId, {
            comment,
            label: rules.labels.wikiNotFollowed,
            bucket: cls.category.bucketName,
            subBucket: "Wiki/Template not followed",
            claimStatus: "Denied",
            summary: "Wiki not followed",
            reimbursementAmount: "0"
          });
          finding.autoProcessed = true;
          finding.autoAction = "resolved_wiki_not_followed";
          finding.autoResult = result;
          continue;
        }

        // Yoda lookup
        const yodaResult = await performYodaLookupBg(orderIds);
        if (yodaResult.success && yodaResult.analysis) {
          const assignee = yodaResult.analysis.assignee;
          if (assignee) {
            console.log(`[AutoMode] EF assigning to ${assignee}: ${issueId}`);
            const result = await assignIssueBg(issueId, assignee);
            finding.autoProcessed = true;
            finding.autoAction = "assigned_ef";
            finding.autoResult = result;
            finding.efYodaData = yodaResult.analysis;
          }
        } else {
          finding.efYodaError = yodaResult.error;
        }
        continue;
      }

      // ── WIKI NOT FOLLOWED → auto-resolve ──
      if (cls.status === "CLASSIFIED" && finding.fieldCheck?.missing?.length > 0) {
        const cat = cls.category;
        console.log(`[AutoMode] Wiki not followed: ${issueId}`);
        const comment = buildWikiNotFollowedComment(rules, cat, finding.fieldCheck, finding.title);
        const result = await fullAutoResolveBg(issueId, {
          comment,
          label: rules.labels.wikiNotFollowed,
          bucket: cat.bucketName,
          subBucket: "Wiki/Template not followed",
          claimStatus: "Denied",
          summary: "Wiki not followed",
          reimbursementAmount: "0"
        });
        finding.autoProcessed = true;
        finding.autoAction = "resolved_wiki_not_followed";
        finding.autoResult = result;
        continue;
      }

      // ── CLASSIFIED + ALL FIELDS PRESENT → auto-assign ──
      if (cls.status === "CLASSIFIED" && cls.category?.assignee && finding.fieldCheck?.missing?.length === 0) {
        console.log(`[AutoMode] Assigning to ${cls.category.assignee}: ${issueId}`);
        const result = await assignIssueBg(issueId, cls.category.assignee);
        finding.autoProcessed = true;
        finding.autoAction = "assigned";
        finding.autoResult = result;
        continue;
      }

    } catch (err) {
      console.error(`[AutoMode] Error processing ${issueId}:`, err);
      finding.autoError = err.message;
    }
  }

  // Save updated findings
  await chrome.storage.local.set({ findings });
}

function buildWikiNotFollowedComment(rules, category, fieldCheck, title) {
  // Use EF-specific template for EF channel tickets
  if (category?.isEFChannel && rules.efWikiNotFollowedCommentTemplate) {
    return rules.efWikiNotFollowedCommentTemplate;
  }
  let comment = rules.wikiNotFollowedCommentTemplate || "";
  const missingList = (fieldCheck.missing || []).map(f => `• ${f}`).join("\n");
  comment = comment.replace("{MISSING_FIELDS}", missingList);
  comment = comment.replace("{SAMPLE_FORMAT}", category.sampleFormat || "");
  comment = comment.replace("{CLAIM_WINDOW_DAYS}", String(category.claimWindowDays || ""));
  comment = comment.replace("{CLAIM_WINDOW_FROM}", (category.claimWindowFrom || "").replace(/_/g, " "));
  comment = comment.replace("{TITLE}", title || "");
  return comment;
}