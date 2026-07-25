// FBA Monitor - Background v7 (evidence-aware field check)
const POLL_INTERVAL_MIN = 5;
const DASHBOARD_ID = "2884899d-54a7-409b-9e88-b7ca4b0416ba";
const SEARCH_URL = `https://issues.amazon.com/issues/search?q=assignee%3A(nobody)+in%3A(${DASHBOARD_ID})+status%3A(Open)+folderType%3A(Default)&sort=score+desc`;
const MAX_HISTORY = 100;

let rulesCache = null;

async function loadRules() {
  if (rulesCache) return rulesCache;
  const res = await fetch(chrome.runtime.getURL("rules.json"));
  rulesCache = await res.json();
  return rulesCache;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("pollUnassigned", { periodInMinutes: POLL_INTERVAL_MIN });
  chrome.storage.local.set({ findings: {}, previousQueue: [], scanHistory: [], lastScanAt: null });
  console.log("[FBA Monitor BG v7] Installed.");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "pollUnassigned") await runScan();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "manualScan") {
    runScan().then(r => sendResponse(r));
    return true;
  }
});

async function runScan() {
  console.log("[FBA Monitor BG v7] Starting scan...");
  try {
    const tab = await ensureSearchTab();
    if (!tab) return { success: false, error: "No issues.amazon.com tab available" };

    const ready = await waitForContentScript(tab.id, 15000);
    if (!ready) return { success: false, error: "Content script not responding. Reload the tab (Ctrl+F5)." };

    const response = await sendMessageWithRetry(tab.id, {
      action: "performScan", dashboardId: DASHBOARD_ID
    }, 3);

    if (!response || !response.success) {
      return { success: false, error: response?.error || "Scan failed" };
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

    const newUuids      = currentQueueUuids.filter(u => !previousQueueSet.has(u));
    const stillUuids    = currentQueueUuids.filter(u => previousQueueSet.has(u));
    const resolvedUuids = [...previousQueueSet].filter(u => !currentQueueSet.has(u));

    console.log(`[FBA Monitor BG v7] New: ${newUuids.length}, Still: ${stillUuids.length}, Resolved: ${resolvedUuids.length}`);

    for (const issue of (response.issues || [])) {
      const classification = classifier.classify(issue.description);

      let fieldCheck = null;
      const cat = classification.status === "CLASSIFIED" ? classification.category :
                  (classification.status === "AMBIGUOUS" ? classification.top2?.[0]?.category : null);

      if (cat) {
        fieldCheck = classifier.checkMandatoryFields(
          issue.description, cat,
          issue.attachments || [], issue.externalLinks || []
        );
      }

      const existing = findings[issue.issueId];
      findings[issue.issueId] = {
        issueId: issue.issueId,
        title: issue.title,
        creator: issue.creator,
        firstSeenAt: existing?.firstSeenAt || now,
        lastSeenAt: now,
        lastScannedAt: now,
        status: "active",
        isNewInLastScan: !previousQueueSet.has(issue.issueId),
        classification,
        fieldCheck,
        attachments: issue.attachments || [],
        externalLinks: issue.externalLinks || [],
        rawDescription: (issue.description || "").slice(0, 5000)
      };
    }

    for (const uuid of resolvedUuids) {
      if (findings[uuid]) {
        findings[uuid].status = "resolved";
        findings[uuid].resolvedAt = now;
        findings[uuid].isNewInLastScan = false;
      }
    }
    for (const uuid of stillUuids) {
      if (findings[uuid]) findings[uuid].isNewInLastScan = false;
    }

    scanHistory.push({
      scanAt: now, activeCount: currentQueueUuids.length,
      newCount: newUuids.length, resolvedCount: resolvedUuids.length
    });
    if (scanHistory.length > MAX_HISTORY) scanHistory.shift();

    await chrome.storage.local.set({
      findings, previousQueue: currentQueueUuids, scanHistory, lastScanAt: now
    });

    const activeCount = currentQueueUuids.length;
    chrome.action.setBadgeText({ text: activeCount > 0 ? String(activeCount) : "" });
    chrome.action.setBadgeBackgroundColor({ color: newUuids.length > 0 ? "#d13212" : "#146eb4" });

    if (newUuids.length > 0) {
      try {
        chrome.notifications.create({
          type: "basic", iconUrl: "icons/icon128.png",
          title: `FBA Monitor: ${newUuids.length} NEW`,
          message: `${activeCount} active. ${resolvedUuids.length} resolved.`
        });
      } catch (e) {}
    }

    return { success: true, newCount: newUuids.length, activeCount, resolvedCount: resolvedUuids.length };
  } catch (err) {
    console.error("[FBA Monitor BG v7] Scan failed:", err);
    return { success: false, error: err.message };
  }
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
    catch (e) {
      if (i === maxRetries - 1) throw e;
      await sleep(1000);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ Evidence-aware Classifier ============
class IssueClassifierWrapper {
  constructor(rules) { this.rules = rules; }

  classify(text) {
    const normalized = (text || "").toLowerCase();
    const scores = this.rules.categories.map(cat => this.scoreCategory(cat, normalized));
    scores.sort((a, b) => b.score - a.score);
    const top = scores[0], second = scores[1];

    if (top.category.action === "REDIRECT" && top.score >= 30) {
      return { status: "REDIRECT", category: top.category, score: top.score,
               message: `${top.category.parent} → ${top.category.redirectTo || 'external team'}`,
               cti: top.category.cti };
    }
    if (second && (top.score - second.score) < this.rules.ambiguityThreshold) {
      return { status: "AMBIGUOUS",
        top2: [{ category: top.category, score: top.score, signals: top.signals },
               { category: second.category, score: second.score, signals: second.signals }],
        message: `Ambiguous: ${top.category.name} (${top.score}) vs ${second.category.name} (${second.score})` };
    }
    if (top.score < this.rules.minConfidenceScore) {
      return { status: "UNCLASSIFIABLE", topGuess: { category: top.category, score: top.score, signals: top.signals },
               message: "Below confidence threshold." };
    }
    return { status: "CLASSIFIED", category: top.category, score: top.score, signals: top.signals };
  }

  scoreCategory(cat, text) {
    let score = 0; const signals = [];
    if (cat.primaryIdRegex && new RegExp(cat.primaryIdRegex, "i").test(text)) {
      score += 50; signals.push(`Primary ID "${cat.primaryIdField}" (+50)`);
    }
    for (const kw of cat.exclusiveKeywords || []) {
      if (new RegExp(`\\b${this.esc(kw)}\\b`, "i").test(text)) {
        score += 15; signals.push(`ExclKw "${kw}" (+15)`);
      }
    }
    for (const kw of cat.keywords || []) {
      if (new RegExp(`\\b${this.esc(kw)}\\b`, "i").test(text)) {
        score += 10; signals.push(`Kw "${kw}" (+10)`);
      }
    }
    for (const field of cat.mandatoryFields || []) {
      const aliases = this.rules.fieldAliases[field] || [field.toLowerCase()];
      for (const a of aliases) {
        if (new RegExp(`\\b${this.esc(a)}\\b`, "i").test(text)) {
          score += 5; signals.push(`Field "${field}" (+5)`); break;
        }
      }
    }
    return { category: cat, score, signals };
  }

  // Evidence-aware: checks text, attachments, and external links
  checkMandatoryFields(text, category, attachments = [], externalLinks = []) {
    const result = { present: [], missing: [], values: {}, evidence: {} };
    const lines = (text || "").split(/\n+/);

    for (const field of category.mandatoryFields || []) {
      const aliases = this.rules.fieldAliases[field] || [field.toLowerCase()];
      let found = false, value = null, source = null;

      // Source 1: Text label with value (handles numbered prefix, parentheticals, : or - separators)
      for (const alias of aliases) {
        const re = new RegExp(
          `^\\s*(?:\\d+[.:]\\s*)?${this.esc(alias)}\\s*(?:\\([^)]*\\))?\\s*[:\\-]\\s*(.+)$`,
          "im"
        );
        for (const line of lines) {
          const m = line.match(re);
          if (m && m[1] && !this.isPlaceholder(m[1])) {
            found = true; value = m[1].trim(); source = "text_label"; break;
          }
        }
        if (found) break;
      }

      // Source 2: Attachment evidence
      if (!found) {
        const evidenceType = this.mapFieldToAttachmentType(field);
        if (evidenceType) {
          const match = attachments.find(a => a.type === evidenceType);
          if (match) {
            found = true; value = `[Attachment: ${match.filename}]`; source = "attachment";
          }
        }
      }

      // Source 3: External link evidence
      if (!found) {
        const linkTypes = this.mapFieldToLinkTypes(field);
        if (linkTypes.length > 0) {
          const match = externalLinks.find(l => linkTypes.includes(l.type));
          if (match) {
            found = true; value = `[Link: ${match.type}]`; source = "external_link";
          }
        }
      }

      if (found) {
        result.present.push(field);
        result.values[field] = value;
        result.evidence[field] = source;
      } else {
        result.missing.push(field);
      }
    }
    return result;
  }

  mapFieldToAttachmentType(field) {
    const map = {
      "Unboxing Video": "video",
      "Product Images": "image",
      "POD": "pod",
      "EPOD": "pod",
      "Invoice": "invoice",
      "STN": "pod"
    };
    return map[field] || null;
  }

  mapFieldToLinkTypes(field) {
    const map = {
      "Unboxing Video": ["gdrive", "youtube"],
      "Product Images": ["gdrive", "amazon_attachment"],
      "POD": ["amazon_attachment"],
      "Invoice": ["gdrive", "amazon_attachment"]
    };
    return map[field] || [];
  }

  isPlaceholder(v) {
    const s = (v || "").trim().toLowerCase();
    return s === "" || s === "n/a" || s === "na" || s === "tbd" || s === "-";
  }
  esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
}