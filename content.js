// FBA Monitor Content Script v8 - full feature set
(function () {
  console.log("[FBA Monitor CS v8] Loaded on", location.href);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "ping") { sendResponse({ pong: true, url: location.href }); return false; }
    if (msg.action === "performScan") {
      performScan(msg.dashboardId)
        .then(r => sendResponse(r))
        .catch(e => { console.error("[FBA Monitor CS v8]", e); sendResponse({ success: false, error: e.message }); });
      return true;
    }
    if (msg.action === "fillComment") {
      fillCommentTextarea(msg.issueId, msg.commentText)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ success: false, error: e.message }));
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
    if (!ready) return { success: false, error: "Search results did not render." };

    const cards = getIssueCards();
    console.log("[FBA Monitor CS v8] Found " + cards.length + " cards");
    if (cards.length === 0) return { success: false, error: "No issue cards found." };

    const issues = [];
    const scrapedUuids = new Set();

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      console.log(`[FBA Monitor CS v8] ${i + 1}/${cards.length}: ${card.srTag}`);
      try {
        const issue = await scrapeCard(card, scrapedUuids);
        if (issue) {
          issues.push(issue);
          scrapedUuids.add(issue.issueId);
        }
      } catch (e) {
        console.warn(`[FBA Monitor CS v8] Failed ${card.srTag}:`, e.message);
      }
    }
    return { success: true, issues };
  }

  function getIssueCards() {
    const cards = [];
    const seen = new Set();
    const srPattern = /^\s*(SR--?\d+|SP[_-]SEED--?\d+|BP[_-]SEED--?\d+)\s*$/i;

    document.querySelectorAll("*").forEach(el => {
      let ownText = "";
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
      }
      const match = ownText.match(srPattern);
      if (!match) return;
      const srTag = match[1].trim();
      if (seen.has(srTag)) return;
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
              const leftPanelTitle = extractLeftPanelTitle(cardText, srTag);
              cards.push({ srTag, element: card, leftPanelTitle });
              break;
            }
          }
        }
        card = card.parentElement;
      }
    });
    return cards;
  }

  function extractLeftPanelTitle(cardText, srTag) {
    const lines = cardText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
      if (line === srTag) continue;
      if (/^\d+[hdm]\s*ago$/i.test(line)) continue;
      if (/^Reimbursements India/i.test(line)) continue;
      if (/^\d+$/.test(line)) continue;
      if (/<.+>/.test(line) || /^MFI/i.test(line) || /LEADERSHIP/i.test(line) ||
          /\[EXTERNAL\]/i.test(line) || (line.length > 15 && line.length < 200)) {
        return line;
      }
    }
    return srTag;
  }

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
    if (!uuid || scrapedUuids.has(uuid)) return null;

    await sleep(1000);
    await waitFor(() => {
      const text = document.body.innerText || "";
      return new RegExp(`IDs:[^\\n]*${uuid}`, 'i').test(text);
    }, 5000);

    const description = extractDescriptionForUuid(uuid);
    const title = card.leftPanelTitle || card.srTag;
    const creator = extractCreator(description);
    const attachments = extractAttachmentsForUuid(uuid);
    const externalLinks = extractExternalLinks(description);

    return {
      issueId: uuid,
      title,
      srTag: card.srTag,
      description: description || "",
      creator: creator || "Unknown",
      attachments,
      externalLinks
    };
  }

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

  function extractAttachmentsForUuid(uuid) {
    const fullText = document.body.innerText || "";
    const idsRe = new RegExp(`IDs:[^\\n]*${uuid}`, 'i');
    const idsMatch = fullText.match(idsRe);
    if (!idsMatch) return [];
    const afterIds = fullText.substring(fullText.indexOf(idsMatch[0]));
    const attachments = [];
    const seen = new Set();
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

  async function fillCommentTextarea(issueId, commentText) {
    await waitFor(() => {
      const m = location.search.match(/selectedDocument=([a-f0-9-]{36})/i);
      return m && m[1].toLowerCase() === issueId.toLowerCase();
    }, 8000);
    await sleep(1000);

    let textarea = null;
    const candidates = [
      "textarea[placeholder*='comment' i]",
      "textarea[aria-label*='comment' i]",
      "textarea[name*='comment' i]",
      ".comment-input textarea",
      "textarea.comment"
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const ctx = (el.closest("form, div, section")?.innerText || "").toLowerCase();
        if (ctx.includes("add comment") || ctx.includes("worklog") || ctx.includes("comment")) {
          textarea = el; break;
        }
      }
      if (textarea) break;
    }
    if (!textarea) {
      const all = Array.from(document.querySelectorAll("textarea")).filter(t => t.offsetParent !== null);
      if (all.length > 0) textarea = all[all.length - 1];
    }
    if (!textarea) return { success: false, error: "Comment textarea not found" };

    textarea.value = commentText;
    ["input", "change", "keyup"].forEach(evt =>
      textarea.dispatchEvent(new Event(evt, { bubbles: true }))
    );
    textarea.focus();
    textarea.scrollIntoView({ behavior: "smooth", block: "center" });
    return { success: true, message: "Draft filled. Review and click Comment to post." };
  }

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

  window.__FBAMonitor = {
    getIssueCards, getCurrentSelectedUuid,
    extractDescriptionForUuid, extractAttachmentsForUuid, extractExternalLinks
  };
  console.log("[FBA Monitor CS v8] Debug helper: window.__FBAMonitor");
})();