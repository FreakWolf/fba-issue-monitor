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
  if (alarm.name === "pollUnassigned") await runScan();
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
});

async function runScan() {
  console.log("[FBA Monitor BG v8.7] Starting scan...");
  try {
    const tab = await ensureSearchTab();
    if (!tab) return { success: false, error: "No SIM tab available" };
    const ready = await waitForContentScript(tab.id, 15000);
    if (!ready) return { success: false, error: "Content script not ready. Reload the tab." };
    const response = await sendMessageWithRetry(tab.id, { action: "performScan", dashboardId: DASHBOARD_ID }, 3);
    if (!response || !response.success) return { success: false, error: response?.error || "Scan failed" };

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
      const classification = classifier.classify(issue.description);
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
  const searchTabs = await chrome.tabs.query({ url: "https://issues.amazon.com/issues/search*" });
  if (searchTabs.length > 0) return searchTabs[0];
  const anyTabs = await chrome.tabs.query({ url: "https://issues.amazon.com/*" });
  if (anyTabs.length > 0) {
    await chrome.tabs.update(anyTabs[0].id, { url: SEARCH_URL });
    await waitForTabComplete(anyTabs[0].id, 10000);
    return await chrome.tabs.get(anyTabs[0].id);
  }
  const newTab = await chrome.tabs.create({ url: SEARCH_URL, active: false });
  await waitForTabComplete(newTab.id, 15000);
  return await chrome.tabs.get(newTab.id);
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

    const scores = this.rules.categories.map(cat => this.scoreCategory(cat, normalized));
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
  checkFeesOverride(text) {
    const keywords = this.rules.feesOverrideKeywords || [];
    const matched = [];
    for (const kw of keywords) {
      const flex = this.esc(kw).replace(/\s+/g, "\\s+");
      if (new RegExp(`\\b${flex}\\b`, "i").test(text)) {
        matched.push(kw);
      }
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
        const labelRe = new RegExp(`^\\s*(?:\\d+\\s*[.:\\-]\\s*)?${flexAlias}(?:\\s+[\\w/()\\[\\]]+){0,4}\\s*[:\\-=\\u2013\\u2014]\\s*(.*)$`, "i");
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