// FBA Monitor Content Script v7 - attachment + link evidence extraction
(function () {
  console.log("[FBA Monitor CS v7] Loaded on", location.href);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "ping") { sendResponse({ pong: true, url: location.href }); return false; }
    if (msg.action === "performScan") {
      performScan(msg.dashboardId)
        .then(r => sendResponse(r))
        .catch(e => { console.error("[FBA Monitor CS v7]", e); sendResponse({ success: false, error: e.message }); });
      return true;
    }
  });

  async function performScan(dashboardId) {
    if (!location.pathname.includes("/issues/search")) {
      return { success: false, error: "Not on search page: " + location.href };
    }

    const ready = await waitFor(() => {
      const text = document.body.innerText || "";
      return /Displaying\s+\d+\s+matches?/i.test(text) || /no more issues to load/i.test(text);
    }, 20000);

    if (!ready) {
      return { success: false, error: "Search results did not render. Debug: " + JSON.stringify(debugInfo()) };
    }

    const cards = getIssueCards();
    console.log("[FBA Monitor CS v7] Found " + cards.length + " issue cards");
    console.log("[FBA Monitor CS v7] SR tags:", cards.map(c => c.srTag));

    if (cards.length === 0) {
      return { success: false, error: "No issue cards found. Debug: " + JSON.stringify(debugInfo()) };
    }

    const issues = [];
    const scrapedUuids = new Set();

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      console.log(`[FBA Monitor CS v7] ${i + 1}/${cards.length}: ${card.srTag}`);
      try {
        const issue = await scrapeCard(card, scrapedUuids);
        if (issue) {
          issues.push(issue);
          scrapedUuids.add(issue.issueId);
        }
      } catch (e) {
        console.warn(`[FBA Monitor CS v7] Failed ${card.srTag}:`, e.message);
      }
    }
    return { success: true, issues };
  }

  // ============ Find issue cards by SR-tag badges ============
  function getIssueCards() {
    const cards = [];
    const seen = new Set();
    const srPattern = /^\s*(SR--?\d+|SP[_-]SEED--?\d+|BP[_-]SEED--?\d+)\s*$/i;

    const allEls = document.querySelectorAll("*");
    for (const el of allEls) {
      let ownText = "";
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
      }
      const match = ownText.match(srPattern);
      if (!match) continue;

      const srTag = match[1].trim();
      if (seen.has(srTag)) continue;
      seen.add(srTag);

      let card = el.parentElement;
      for (let depth = 0; depth < 15 && card; depth++) {
        const cardText = card.innerText || "";
        if (cardText.length > 50 && cardText.length < 2000 && cardText.includes(srTag)) {
          const parent = card.parentElement;
          if (parent) {
            const similarSiblings = Array.from(parent.children).filter(sibling => {
              const sibText = sibling.innerText || "";
              return /SR--?\d+|SP[_-]SEED--?\d+|BP[_-]SEED--?\d+/i.test(sibText) && sibText.length > 20;
            });
            if (similarSiblings.length >= 1 && similarSiblings.length <= 30) {
              cards.push({ srTag, element: card });
              break;
            }
          }
        }
        card = card.parentElement;
      }
    }
    return cards;
  }

  // ============ Scrape one card ============
  async function scrapeCard(card, scrapedUuids) {
    card.element.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(200);

    const beforeUuid = getCurrentSelectedUuid();

    card.element.click();
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      card.element.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, button: 0, buttons: 1
      }));
    });

    const innerClickTargets = card.element.querySelectorAll("[role='button'], [tabindex], a, button");
    if (innerClickTargets.length > 0) innerClickTargets[0].click();

    await waitFor(() => {
      const currentUuid = getCurrentSelectedUuid();
      return currentUuid && currentUuid !== beforeUuid;
    }, 3000);

    let uuid = getCurrentSelectedUuid();

    if (!uuid || scrapedUuids.has(uuid)) {
      const links = card.element.querySelectorAll("a, [class*='title'], [class*='link']");
      for (const link of links) {
        link.click();
        await sleep(1200);
        const newUuid = getCurrentSelectedUuid();
        if (newUuid && !scrapedUuids.has(newUuid)) { uuid = newUuid; break; }
      }
    }

    if (!uuid || scrapedUuids.has(uuid)) {
      console.warn(`[FBA Monitor CS v7] Could not select ${card.srTag}`);
      return null;
    }

    await sleep(1000);
    await waitFor(() => {
      const text = document.body.innerText || "";
      return new RegExp(`IDs:[^\\n]*${uuid}`, 'i').test(text);
    }, 5000);

    const description = extractDescriptionForUuid(uuid);
    const title = extractTitleForUuid(uuid) || card.srTag;
    const creator = extractCreator(description);
    const attachments = extractAttachmentsForUuid(uuid);
    const externalLinks = extractExternalLinks(description);

    return {
      issueId: uuid,
      title,
      description: description || "",
      creator: creator || "Unknown",
      attachments,
      externalLinks
    };
  }

  // ============ URL and text helpers ============
  function getCurrentSelectedUuid() {
    const m = location.search.match(/selectedDocument=([a-f0-9-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }

  function extractDescriptionForUuid(uuid) {
    const fullText = document.body.innerText || "";
    const idsRe = new RegExp(`IDs:[^\\n]*${uuid}`, 'i');
    const idsMatch = fullText.match(idsRe);
    if (!idsMatch) return "";

    const idsIndex = fullText.indexOf(idsMatch[0]);
    const beforeIds = fullText.substring(0, idsIndex);

    let startIdx = -1;
    const m1 = /Assign to a user\s*\n\s*Edit\s*\n/gi;
    const m1Matches = [...beforeIds.matchAll(m1)];
    if (m1Matches.length > 0) {
      const last = m1Matches[m1Matches.length - 1];
      startIdx = last.index + last[0].length;
    }
    if (startIdx < 0) {
      const m2 = /(?:^|\n)Edit\s*\n/g;
      const m2Matches = [...beforeIds.matchAll(m2)];
      if (m2Matches.length > 0) {
        const last = m2Matches[m2Matches.length - 1];
        startIdx = last.index + last[0].length;
      }
    }
    if (startIdx < 0) {
      const m3 = beforeIds.match(/\n\d{1,2}[.:]\s+[A-Z]/);
      if (m3) startIdx = beforeIds.lastIndexOf(m3[0]);
    }
    if (startIdx < 0) return "";

    let description = fullText.substring(startIdx, idsIndex).trim();
    description = description.replace(/^(Edit fields\s*\n)+/, "").trim();
    return description;
  }

  // ============ Title (fixed: SR tag from IDs line only) ============
  function extractTitleForUuid(uuid) {
    const fullText = document.body.innerText || "";
    const idsRe = new RegExp(`IDs:\\s*([^\\n]*${uuid}[^\\n]*)`, 'i');
    const idsMatch = fullText.match(idsRe);
    if (!idsMatch) return null;

    const idsLine = idsMatch[1] || "";
    const srInIdsLine = idsLine.match(/(SR--?\d+|SP_SEED--?\d+|BP_SEED--?\d+)/i);
    const srTag = srInIdsLine ? srInIdsLine[1] : null;

    const idsIndex = fullText.indexOf(idsMatch[0]);
    const section = fullText.substring(Math.max(0, idsIndex - 2000), idsIndex);
    const lines = section.split("\n").map(l => l.trim()).filter(l => l.length > 3);

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (/^(<.+>|MFI\s*<|.*LEADERSHIP.*|\[EXTERNAL\])/i.test(line) && line.length < 300) {
        return srTag ? `${line} (${srTag})` : line;
      }
    }
    return srTag;
  }

  function extractCreator(desc) {
    const text = (desc || "") + "\n" + (document.body.innerText || "");
    const patterns = [
      /([A-Z][a-zA-Z]+\s+[A-Z][a-zA-Z]*)\s*\|\s*(Account Manager|Key Account Manager|SPS Account Manager|Sales Associate|Manager|Analyst|Engineer)/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m[1].trim();
    }
    return null;
  }

  // ============ NEW: Attachment extraction ============
  function extractAttachmentsForUuid(uuid) {
    const fullText = document.body.innerText || "";
    const idsRe = new RegExp(`IDs:[^\\n]*${uuid}`, 'i');
    const idsMatch = fullText.match(idsRe);
    if (!idsMatch) return [];

    const afterIds = fullText.substring(fullText.indexOf(idsMatch[0]));
    const attachments = [];
    const seen = new Set();

    // Pattern: "attached the file FILENAME.ext"
    const re = /attached the file\s+([^\n]+?\.(?:jpg|jpeg|png|gif|pdf|xlsx|xls|docx|mp4|mov|avi|tmp|csv|zip))/gi;
    let m;
    while ((m = re.exec(afterIds)) !== null) {
      const filename = m[1].trim();
      if (seen.has(filename)) continue;
      seen.add(filename);
      attachments.push({ filename, type: classifyAttachment(filename) });
      if (attachments.length > 100) break;
    }
    return attachments;
  }

  function classifyAttachment(filename) {
    const lower = filename.toLowerCase();
    if (/\.(jpg|jpeg|png|gif|bmp|webp)$/.test(lower)) return "image";
    if (/\.(mp4|mov|avi|wmv|mkv|webm)$/.test(lower)) return "video";
    if (/\.pdf$/.test(lower)) {
      if (/pod|delivery|epod/i.test(lower)) return "pod";
      if (/invoice/i.test(lower)) return "invoice";
      return "pdf";
    }
    if (/\.(xlsx|xls|csv)$/.test(lower)) {
      if (/invoice|analysis|shipment/i.test(lower)) return "invoice";
      return "spreadsheet";
    }
    return "other";
  }

  // ============ NEW: External link extraction ============
  function extractExternalLinks(text) {
    if (!text) return [];
    const links = [];
    const seen = new Set();
    const urlRe = /https?:\/\/[^\s\)\]<>"']+/gi;
    let m;
    while ((m = urlRe.exec(text)) !== null) {
      const url = m[0].replace(/[.,;]$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      let type = "other";
      if (/drive\.google/i.test(url)) type = "gdrive";
      else if (/youtu\.?be/i.test(url)) type = "youtube";
      else if (/t\.corp\.amazon\.com/i.test(url)) type = "amazon_tt";
      else if (/maxis-file-service/i.test(url)) type = "amazon_attachment";
      links.push({ url, type });
      if (links.length > 30) break;
    }
    return links;
  }

  // ============ Debug ============
  function debugInfo() {
    const bodyText = document.body.innerText || "";
    return {
      totalAnchorsWithSelectedDoc: document.querySelectorAll("a[href*='selectedDocument=']").length,
      totalAnchorsAny: document.querySelectorAll("a").length,
      totalDivs: document.querySelectorAll("div").length,
      bodyHasDisplayingText: /displaying\s+\d+\s+matches/i.test(bodyText),
      bodyHasNoMoreText: /no more issues/i.test(bodyText),
      srTagsInBody: (bodyText.match(/SR--?\d+|SP[_-]SEED--?\d+/g) || []).slice(0, 10),
      cardCount: getIssueCards().length,
      currentUrl: location.href
    };
  }

  // ============ Utilities ============
  function waitFor(predicate, timeoutMs) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        try { if (predicate()) return resolve(true); } catch (e) {}
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(check, 300);
      };
      check();
    });
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ============ Debug helpers ============
  window.__FBAMonitor = {
    getIssueCards,
    getCurrentSelectedUuid,
    extractDescriptionForUuid,
    extractTitleForUuid,
    extractCreator,
    extractAttachmentsForUuid,
    extractExternalLinks,
    debugInfo
  };
  console.log("[FBA Monitor CS v7] Debug helper: window.__FBAMonitor");
})();