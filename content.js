(function () {
  console.log("[FBA Monitor CS v11.9] Loaded on", location.href);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "ping") { sendResponse({ pong: true, url: location.href }); return false; }
    if (msg.action === "performScan") {
      performScan(msg.dashboardId).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.action === "assignIssue") {
      assignIssueToUser(msg.issueId, msg.username).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.action === "fullAutoResolve") {
      fullAutoResolve(msg.issueId, msg.options).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });

  async function performScan(dashboardId) {
    if (!location.pathname.includes("/issues/search")) return { success: false, error: "Not on search page" };
    const ready = await waitFor(() => {
      const text = document.body.innerText || "";
      return /Displaying\s+\d+\s+matches?/i.test(text) || /no more issues to load/i.test(text);
    }, 20000);
    if (!ready) return { success: false, error: "Search results did not render" };
    await waitFor(() => !(document.body.innerText || "").includes("Loading folder path"), 10000);
    await sleep(1500);
    const cards = getIssueCards();
    console.log("[FBA Monitor CS v11.9] Found " + cards.length + " cards");
    if (cards.length === 0) return { success: false, error: "No issue cards found" };
    const issues = [];
    const scrapedUuids = new Set();
    for (let i = 0; i < cards.length; i++) {
      try {
        const issue = await scrapeCard(cards[i], scrapedUuids);
        if (issue) { issues.push(issue); scrapedUuids.add(issue.issueId); }
      } catch (e) { console.warn(`Failed ${cards[i].srTag}:`, e.message); }
    }
    return { success: true, issues };
  }

  function getIssueCards() {
    const cards = [];
    const seen = new Set();
    const srPattern = /^\s*([A-Z]{2,10}[_-]?(?:SEED)?[_-]{1,2}\d+)\s*$/i;
    const anySrTagPattern = /(SR|SP|BP|SVM|MFN|NR|IR|LESC|NOC|ESPR|SP_SEED|BP_SEED)[_-]{1,2}\d+/gi;
    document.querySelectorAll("*").forEach(el => {
      let ownText = "";
      for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
      const match = ownText.match(srPattern);
      if (!match) return;
      const srTag = match[1].trim();
      if (seen.has(srTag)) return;
      seen.add(srTag);
      let bestCard = null, bestTitle = null;
      let node = el.parentElement;
      for (let depth = 0; depth < 15 && node; depth++) {
        const nodeText = node.innerText || "";
        if (nodeText.length > 50 && nodeText.length < 3000 && nodeText.includes(srTag)) {
          const allSrTags = nodeText.match(anySrTagPattern) || [];
          const otherTags = allSrTags.filter(t => t.toLowerCase().replace(/[_-]+/g, "-") !== srTag.toLowerCase().replace(/[_-]+/g, "-"));
          if (otherTags.length === 0) {
            const potentialTitle = extractLeftPanelTitle(nodeText, srTag);
            if (potentialTitle && potentialTitle !== srTag && potentialTitle.length > 10 && !/^Loading/i.test(potentialTitle)) {
              bestCard = node; bestTitle = potentialTitle; break;
            }
            if (!bestCard) { bestCard = node; bestTitle = potentialTitle || srTag; }
          }
        }
        node = node.parentElement;
      }
      if (bestCard) {
        const finalTitle = (bestTitle && !/^Loading/i.test(bestTitle) && !/^\d+\.\s+[A-Z][a-zA-Z]+\s*:/.test(bestTitle)) ? bestTitle : srTag;
        cards.push({ srTag, element: bestCard, leftPanelTitle: finalTitle });
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
      if (/^(assigned|status|severity|next step|created)/i.test(line)) continue;
      if (/^Loading/i.test(line)) continue;
      if (/^\d+\.\s+(Merchant\s*ID|Shipment\s*ID|Case\s*ID|Order\s*ID|Removal\s*Order\s*ID|SPS\s*Case\s*ID|Transaction\s*ID|FNSKU|Quantity|LPN)/i.test(line)) continue;
      if (/^(Merchant\s*ID|Shipment\s*ID|Case\s*ID|Order\s*ID|Removal\s*Order\s*ID|SPS\s*Case\s*ID|Transaction\s*ID|FNSKU|Quantity|LPN)\s*[:\-]/i.test(line)) continue;
      if (/^\d+\.\s+[A-Z][a-zA-Z ]{2,30}\s*:/i.test(line)) continue;
      if (/<.+>/.test(line) ||
        /^(MFI|SVM|MFN|LEADERSHIP)/i.test(line) ||
        /\[EXTERNAL\]|SAFE-T|Incorrect|Program\s+Solve|Handling\s+Fee|weight|Removal/i.test(line) ||
        (line.length > 15 && line.length < 300 && !/^\d/.test(line) && !/^Loading/i.test(line))) {
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
      card.element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 }));
    });
    const inner = card.element.querySelectorAll("[role='button'], [tabindex], a, button");
    if (inner.length > 0) inner[0].click();
    await waitFor(() => { const c = getCurrentSelectedUuid(); return c && c !== beforeUuid; }, 3000);
    let uuid = getCurrentSelectedUuid();
    if (!uuid || scrapedUuids.has(uuid)) {
      const links = card.element.querySelectorAll("a, [class*='title'], [class*='link']");
      for (const link of links) {
        link.click(); await sleep(1200);
        const newUuid = getCurrentSelectedUuid();
        if (newUuid && !scrapedUuids.has(newUuid)) { uuid = newUuid; break; }
      }
    }
    if (!uuid || scrapedUuids.has(uuid)) return null;
    await sleep(1000);
    await waitFor(() => { const text = document.body.innerText || ""; return new RegExp(`IDs:[^\\n]*${uuid}`, 'i').test(text); }, 5000);
    const description = extractDescriptionForUuid(uuid);
    const rightPanelTitle = extractRightPanelTitle(uuid);
    const title = (rightPanelTitle && !/^Loading/i.test(rightPanelTitle))
      ? rightPanelTitle
      : (card.leftPanelTitle && !/^Loading/i.test(card.leftPanelTitle) && card.leftPanelTitle !== card.srTag
        ? card.leftPanelTitle : card.srTag);
    const creator = extractCreator(description);
    const attachments = extractAttachmentsForUuid(uuid);
    const externalLinks = extractExternalLinks(description);
    return { issueId: uuid, title, srTag: card.srTag, description: description || "", creator: creator || "Unknown", attachments, externalLinks };
  }

  function extractRightPanelTitle(uuid) {
    const fullText = document.body.innerText || "";
    const idsRe = new RegExp(`IDs:[^\\n]*${uuid}`, 'i');
    const idsMatch = fullText.match(idsRe);
    if (!idsMatch) return null;
    const idsIndex = fullText.indexOf(idsMatch[0]);
    const section = fullText.substring(Math.max(0, idsIndex - 3000), idsIndex);
    const lines = section.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const breadcrumbPattern = /Reimbursements\s+India\s*[▼\/].*\/\s*(SR|SP|BP|SVM|MFN|NR|IR|LESC|NOC|ESPR|SP_SEED|BP_SEED)[_-]{1,2}\d+/i;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (breadcrumbPattern.test(lines[i])) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const candidate = lines[j];
          if (candidate.length < 10 || candidate.length > 300) continue;
          if (/^\d+$/.test(candidate)) continue;
          if (/^Loading/i.test(candidate)) continue;
          if (/^(Edit|Actions|Overview|Information|Planning|Event Management|Audit Trail|Assign to|Severity|Status|Next step|Created)/i.test(candidate)) continue;
          if (/^(Displaying|Sort by|SEARCH|Current Filters|View on Taskei)/i.test(candidate)) continue;
          if (/^\d+\.\s+[A-Z][a-zA-Z ]{2,30}\s*:/i.test(candidate)) continue;
          return candidate;
        }
      }
    }
    return null;
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
    if (m1Matches.length > 0) { const last = m1Matches[m1Matches.length - 1]; startIdx = last.index + last[0].length; }
    if (startIdx < 0) {
      const m2 = /(?:^|\n)Edit\s*\n/g;
      const m2Matches = [...beforeIds.matchAll(m2)];
      if (m2Matches.length > 0) { const last = m2Matches[m2Matches.length - 1]; startIdx = last.index + last[0].length; }
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
    const m = text.match(/([A-Z][a-zA-Z]+\s+[A-Z][a-zA-Z]*)\s*\|\s*(Account Manager|Key Account Manager|SPS Account Manager|Sales Associate|Manager|Analyst|Engineer|Strategic Account Manager|SBS-Assistant Brand Manager|Brand Manager|Program Specialist)/);
    return m ? m[1].trim() : null;
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

  async function assignIssueToUser(issueId, username) {
    await waitForIssueSelected(issueId);
    await sleep(1500);
    const assignCandidates = [];
    document.querySelectorAll("*").forEach(el => {
      let ownText = "";
      for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
      if (/assign to a user/i.test(ownText.trim()) && el.offsetParent !== null) assignCandidates.push(el);
    });
    if (assignCandidates.length === 0) return { success: false, error: "'Assign to a user' element not found" };
    let clickTarget = assignCandidates[0];
    let node = clickTarget;
    for (let i = 0; i < 5 && node; i++) {
      if (node.tagName === "A" || node.tagName === "BUTTON" || node.getAttribute("role") === "button" || node.onclick) { clickTarget = node; break; }
      node = node.parentElement;
    }
    clickTarget.click();
    ['mousedown', 'mouseup', 'click'].forEach(evt => clickTarget.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })));
    await sleep(2000);
    let userInput = null;
    const inputs = Array.from(document.querySelectorAll("input[type='text'], input[type='search'], input:not([type])")).filter(inp => inp.offsetParent !== null);
    for (const inp of inputs) {
      const placeholder = (inp.placeholder || "").toLowerCase();
      const ariaLabel = (inp.getAttribute("aria-label") || "").toLowerCase();
      if (placeholder.includes("user") || placeholder.includes("assign") || placeholder.includes("search") || ariaLabel.includes("user") || ariaLabel.includes("assign")) { userInput = inp; break; }
    }
    if (!userInput && inputs.length > 0) userInput = inputs[inputs.length - 1];
    if (!userInput) return { success: false, error: "Assignee input not found" };
    userInput.focus();
    userInput.value = username;
    ["input", "change", "keyup", "keydown"].forEach(evt => userInput.dispatchEvent(new Event(evt, { bubbles: true })));
    await sleep(2000);
    const suggSelectors = ["li[role='option']", "[role='option']", ".ui-menu-item", ".autocomplete-item", ".dropdown-item", ".select2-result", "li.suggestion"];
    let suggestion = null;
    for (const sel of suggSelectors) {
      const items = Array.from(document.querySelectorAll(sel)).filter(el => el.offsetParent !== null);
      for (const item of items) {
        if ((item.textContent || "").toLowerCase().includes(username.toLowerCase())) { suggestion = item; break; }
      }
      if (suggestion) break;
    }
    if (suggestion) {
      suggestion.click();
      await sleep(1500);
      const saveBtns = Array.from(document.querySelectorAll("button, [role='button']")).filter(b => b.offsetParent !== null && /save|confirm|assign|submit|apply|ok/i.test(b.textContent || ""));
      if (saveBtns.length > 0) {
        const preferred = saveBtns.find(b => /^(assign|save)$/i.test((b.textContent || "").trim())) || saveBtns[0];
        preferred.click();
        await sleep(1000);
      }
      return { success: true, message: `Assigned to ${username}` };
    }
    ["keydown", "keypress", "keyup"].forEach(evt => userInput.dispatchEvent(new KeyboardEvent(evt, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })));
    await sleep(1500);
    return { success: true, message: `Typed "${username}" + Enter (verify in SIM)` };
  }

  async function fullAutoResolve(issueId, options) {
    console.log(`[FBA Monitor CS v11.9] Full auto-resolve: ${issueId}`, options);
    await waitForIssueSelected(issueId);
    await sleep(2000);
    const results = { steps: [] };

    if (options.commentText) {
      const r = await fillCommentTextarea(options.commentText);
      results.steps.push({ step: "fill_comment", ...r });
      if (!r.success) return { success: false, error: "Comment fill: " + r.error, results };
      await sleep(1500);
      if (options.autoSubmit) {
        const s = await submitComment();
        results.steps.push({ step: "submit_comment", ...s });
        await sleep(4000);
      }
    }

    if (options.labelName) {
      const l = await applyLabelToTicket(options.labelName);
      results.steps.push({ step: "apply_label", ...l });
      await sleep(3000);
    }

    if (options.markResolved) {
      scrollToResolveArea();
      await sleep(1000);
      const rr = await markTicketAsResolved(options.resolveConfig);
      results.steps.push({ step: "mark_resolved", ...rr });
    }

    const failed = results.steps.filter(s => !s.success);
    return {
      success: failed.length === 0,
      message: failed.length === 0 ? `Completed ${results.steps.length} steps` : `${results.steps.length - failed.length}/${results.steps.length} succeeded. Failed: ${failed.map(s => s.step).join(", ")}`,
      results
    };
  }

  function scrollToResolveArea() {
    const resolveEl = findElementByOwnText(/^Resolve$/i);
    if (resolveEl) { resolveEl.scrollIntoView({ behavior: 'instant', block: 'center' }); return; }
    const rightPanel = document.querySelector('[class*="detail"], [class*="right-panel"], [class*="issue-detail"]');
    if (rightPanel) rightPanel.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function findElementByOwnText(regex) {
    let found = null;
    document.querySelectorAll('*').forEach(el => {
      if (found) return;
      let ownText = '';
      for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
      if (regex.test(ownText.trim()) && el.offsetParent !== null) found = el;
    });
    return found;
  }

  async function fillCommentTextarea(commentText) {
    let textarea = null;
    const candidates = ["textarea[placeholder*='comment' i]", "textarea[aria-label*='comment' i]", "textarea[name*='comment' i]", ".comment-input textarea", "textarea.comment"];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const ctx = (el.closest("form, div, section")?.innerText || "").toLowerCase();
        if (ctx.includes("add comment") || ctx.includes("worklog") || ctx.includes("comment") || ctx.includes("compose")) { textarea = el; break; }
      }
      if (textarea) break;
    }
    if (!textarea) {
      const all = Array.from(document.querySelectorAll("textarea")).filter(t => t.offsetParent !== null);
      if (all.length > 0) textarea = all[all.length - 1];
    }
    if (!textarea) return { success: false, error: "Comment textarea not found" };
    textarea.value = commentText;
    ["input", "change", "keyup"].forEach(evt => textarea.dispatchEvent(new Event(evt, { bubbles: true })));
    textarea.focus();
    textarea.scrollIntoView({ behavior: "smooth", block: "center" });
    return { success: true };
  }

  async function submitComment() {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit']")).filter(b => {
      const text = ((b.textContent || b.value || "")).trim();
      return /^comment$|^submit\s*comment|^post\s*comment$/i.test(text) && b.offsetParent !== null && !b.disabled;
    });
    if (btns.length === 0) return { success: false, error: "Comment submit button not found" };
    const btn = btns[0];
    btn.click();
    ['mousedown', 'mouseup', 'click'].forEach(evt => btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })));
    await sleep(2500);
    return { success: true, message: "Comment submitted" };
  }

  async function applyLabelToTicket(labelName) {
    console.log(`[FBA Monitor CS v11.9] Applying label: ${labelName}`);
    const inputsBefore = new Set(Array.from(document.querySelectorAll("input, textarea")).filter(inp => inp.offsetParent !== null));
    let addLabelsEl = null;
    document.querySelectorAll("*").forEach(el => {
      if (addLabelsEl) return;
      let ownText = "";
      for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
      const t = ownText.trim();
      if (!/^\+?\s*Add\s+Labels?$/i.test(t) || !el.offsetParent || t.length > 30) return;
      const nearbyText = (el.closest("aside, nav, [class*='sidebar'], [class*='left'], [class*='filter']")?.innerText || "").toLowerCase();
      if (nearbyText.includes("search filters") || nearbyText.includes("current filters")) return;
      addLabelsEl = el;
    });
    if (!addLabelsEl) return { success: false, error: "'+Add Labels' not found" };

    addLabelsEl.scrollIntoView({ behavior: 'instant', block: 'center' });
    await sleep(500);
    addLabelsEl.click();
    await sleep(2000);
    let newInput = findNewInput(inputsBefore);
    if (!newInput) {
      ['mousedown', 'mouseup', 'click'].forEach(evt => addLabelsEl.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })));
      await sleep(2000);
      newInput = findNewInput(inputsBefore);
    }
    if (!newInput) {
      const rect = addLabelsEl.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (target) { target.click(); await sleep(2000); newInput = findNewInput(inputsBefore); }
    }
    if (!newInput) return { success: false, error: "No input appeared after clicking '+Add Labels'" };

    newInput.focus();
    await sleep(300);
    const proto = newInput.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) nativeSetter.call(newInput, labelName); else newInput.value = labelName;
    newInput.dispatchEvent(new Event('input', { bubbles: true }));
    newInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2000);

    const suggestion = findAutocompleteSuggestion(labelName);
    if (suggestion) {
      suggestion.click();
      await sleep(1500);
      return { success: true, message: `Label "${labelName}" applied` };
    }
    newInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    newInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    await sleep(1500);
    return { success: true, message: `Label "${labelName}" typed + Enter` };
  }

  function findNewInput(inputsBefore) {
    return Array.from(document.querySelectorAll("input, textarea"))
      .filter(inp => inp.offsetParent !== null && !inputsBefore.has(inp))[0] || null;
  }

  function findAutocompleteSuggestion(labelName) {
    const selectors = ["li[role='option']", "[role='option']", ".ui-menu-item", ".dropdown-item", "ul[role='listbox'] li"];
    for (const sel of selectors) {
      const items = Array.from(document.querySelectorAll(sel)).filter(el => el.offsetParent !== null);
      for (const item of items) {
        if ((item.textContent || "").toLowerCase().includes(labelName.toLowerCase())) return item;
      }
    }
    return null;
  }

  async function markTicketAsResolved(resolveConfig = {}) {
    console.log("[FBA Monitor CS v11.9] Looking for Resolve header button...", resolveConfig);
    window.scrollTo(0, 0);
    const rightPanel = document.querySelector('[class*="detail"], [class*="right-panel"], [class*="issue-detail"]');
    if (rightPanel) rightPanel.scrollTop = 0;
    await sleep(500);

    let candidates = [];
    document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']").forEach(el => {
      const text = ((el.textContent || el.value || "")).trim();
      if (/^Resolve$/i.test(text) && el.offsetParent !== null && !el.disabled) candidates.push(el);
    });
    if (candidates.length === 0) {
      document.querySelectorAll("*").forEach(el => {
        let ownText = "";
        for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
        if (/^Resolve$/i.test(ownText.trim()) && el.offsetParent !== null) candidates.push(el);
      });
    }
    if (candidates.length === 0) return { success: false, error: "'Resolve' button not found (may already be resolved)" };

    let btn = candidates[0];
    let node = btn;
    for (let i = 0; i < 5 && node; i++) {
      if (node.tagName === "A" || node.tagName === "BUTTON" || node.getAttribute("role") === "button" || node.onclick || node.style?.cursor === "pointer") {
        btn = node; break;
      }
      node = node.parentElement;
    }

    btn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await sleep(500);
    btn.focus();
    btn.click();
    ['mousedown', 'mouseup', 'click'].forEach(evt => btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })));
    await sleep(2000);

    return await fillAndSubmitResolveModal(resolveConfig);
  }

  // ═══════════════════════════════════════════════════════════════
  // ✨ v11.9: RESOLVE MODAL with robust submit button click + verification
  // ═══════════════════════════════════════════════════════════════

  async function fillAndSubmitResolveModal(config = {}) {
    console.log("[FBA Monitor CS v11.9] Waiting for 'Resolve Issue' modal...", config);

    let modal = null;
    for (let i = 0; i < 20; i++) {
      const dialogs = document.querySelectorAll("[role='dialog'], .modal, div");
      for (const d of dialogs) {
        const text = d.innerText || "";
        if (text.includes("Resolve Issue") && text.includes("Root Cause") &&
            d.offsetParent !== null && d.offsetWidth > 400) {
          modal = d;
          break;
        }
      }
      if (modal) break;
      await sleep(400);
    }
    if (!modal) return { success: false, error: "Resolve Issue modal not found" };

    console.log("[FBA Monitor CS v11.9] Modal found. Waiting 1.5s for React render...");
    await sleep(1500);

    const isOutOfScope = config.actionType === "out_of_scope";
    const summaryVal = config.summary || (isOutOfScope ? "out of scope" : "wiki not followed");
    const bucketVal = config.bucket || (isOutOfScope ? "Fees Charged in Error" : "General Enquiry");
    const subBucketVal = config.subBucket || (isOutOfScope ? "Issue Not handled by SR" : "Invalid (Incomplete Information)");
    const actionItemsVal = config.actionItems || summaryVal;

    const results = [];

    results.push({ field: "Root Cause", ok: await setRadioByLabel(modal, "Root Cause", "No") });
    results.push({ field: "Summary", ok: await setTextareaByLabel(modal, "Summary", summaryVal) });
    results.push({ field: "Bucket", ok: await setDropdownByLabel(modal, "Bucket", bucketVal) });
    await sleep(500);
    results.push({ field: "Claim Status", ok: await setDropdownByLabel(modal, "Claim Status", config.claimStatus || "Denied") });
    await sleep(500);
    results.push({ field: "Sub Bucket", ok: await setDropdownByLabel(modal, "Sub Bucket", subBucketVal) });
    await sleep(500);
    results.push({ field: "Business Exception", ok: await setDropdownByLabel(modal, "one time business exception", "No") });
    await sleep(500);
    results.push({ field: "SPS/CTPS Miss", ok: await setCheckboxByLabel(modal, "Not a miss from SPS or CTPS") });
    results.push({ field: "Action Items", ok: await setTextareaByLabel(modal, "Action Items", actionItemsVal) });
    results.push({ field: "Decision Reversal", ok: await setDropdownByLabel(modal, "Decision Reversal", "Decision not reversed") });
    await sleep(500);

    let reimbOk = await setTextInputByLabel(modal, "Reimnbursement Amount", "0");
    if (!reimbOk) reimbOk = await setTextInputByLabel(modal, "Reimbursement Amount", "0");
    results.push({ field: "Reimbursement Amount", ok: reimbOk });

    console.log("[FBA Monitor CS v11.9] Field fill results:", results);
    await sleep(1500);

    // Retry any failed fields
    const failedFirstPass = results.filter(r => !r.ok);
    if (failedFirstPass.length > 0) {
      console.log("[FBA Monitor CS v11.9] Retrying failed fields:", failedFirstPass.map(f => f.field));
      for (const failed of failedFirstPass) {
        await sleep(600);
        let retryOk = false;
        if (failed.field === "Summary") retryOk = await setTextareaByLabel(modal, "Summary", summaryVal);
        else if (failed.field === "Action Items") retryOk = await setTextareaByLabel(modal, "Action Items", actionItemsVal);
        else if (failed.field === "Bucket") retryOk = await setDropdownByLabel(modal, "Bucket", bucketVal);
        else if (failed.field === "Reimbursement Amount") {
          retryOk = await setTextInputByLabel(modal, "Reimnbursement Amount", "0");
          if (!retryOk) retryOk = await setTextInputByLabel(modal, "Reimbursement Amount", "0");
        }
        else if (failed.field === "Claim Status") retryOk = await setDropdownByLabel(modal, "Claim Status", config.claimStatus || "Denied");
        else if (failed.field === "Sub Bucket") retryOk = await setDropdownByLabel(modal, "Sub Bucket", subBucketVal);
        else if (failed.field === "Business Exception") retryOk = await setDropdownByLabel(modal, "one time business exception", "No");
        else if (failed.field === "Decision Reversal") retryOk = await setDropdownByLabel(modal, "Decision Reversal", "Decision not reversed");
        if (retryOk) {
          const idx = results.findIndex(r => r.field === failed.field);
          if (idx >= 0) results[idx].ok = true;
          console.log(`[v11.9] ✓ Retry succeeded for "${failed.field}"`);
        }
      }
      await sleep(1000);
    }

    // ═══ ROBUST RESOLVE BUTTON CLICK WITH VERIFICATION ═══
    console.log("[FBA Monitor CS v11.9] Locating modal Resolve submit button...");

    const allResolveButtons = Array.from(modal.querySelectorAll("button, input[type='submit'], input[type='button']"))
      .filter(b => {
        const t = (b.textContent || b.value || "").trim();
        return /^Resolve$/i.test(t) && b.offsetParent !== null;
      });

    console.log(`[v11.9] Found ${allResolveButtons.length} Resolve buttons in modal`);

    // Prefer the one lowest on the page (footer submit button)
    allResolveButtons.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.top - ra.top;
    });

    const resolveBtn = allResolveButtons[0];

    if (!resolveBtn) {
      return { success: false, error: "Modal Resolve submit button not found", fieldResults: results };
    }

    // Check disabled state via multiple methods
    const isDisabled = resolveBtn.disabled ||
      resolveBtn.getAttribute('aria-disabled') === 'true' ||
      resolveBtn.classList.contains('disabled') ||
      resolveBtn.classList.contains('is-disabled') ||
      window.getComputedStyle(resolveBtn).pointerEvents === 'none';

    if (isDisabled) {
      console.warn("[v11.9] Resolve button appears disabled. Waiting 2s for validation...");
      await sleep(2000);
      const stillDisabled = resolveBtn.disabled || resolveBtn.getAttribute('aria-disabled') === 'true';
      if (stillDisabled) {
        return {
          success: false,
          error: "Modal Resolve button disabled (form validation failed - check required fields)",
          fieldResults: results
        };
      }
    }

    console.log("[v11.9] Scrolling Resolve button into view...");
    resolveBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(500);

    const rect = resolveBtn.getBoundingClientRect();
    const clickX = rect.left + rect.width / 2;
    const clickY = rect.top + rect.height / 2;

    console.log(`[v11.9] Clicking Resolve at (${Math.round(clickX)}, ${Math.round(clickY)})...`);

    resolveBtn.focus();
    await sleep(100);

    // PointerEvent sequence (React 17+ preferred)
    try {
      resolveBtn.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY, pointerType: 'mouse' }));
      resolveBtn.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY, pointerType: 'mouse' }));
      resolveBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY, pointerType: 'mouse', button: 0 }));
    } catch (e) { /* PointerEvent may not be available */ }

    // MouseEvent sequence
    resolveBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY }));
    resolveBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY, button: 0, buttons: 1 }));
    await sleep(50);
    resolveBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY, button: 0, buttons: 0 }));

    try {
      resolveBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY, pointerType: 'mouse', button: 0 }));
    } catch (e) { }

    // Native click (last)
    resolveBtn.click();
    resolveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY, button: 0 }));

    console.log("[v11.9] Click dispatched. Waiting for modal to close...");

    // Wait up to 8s for modal to close
    let modalClosed = false;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      const modalStillVisible = modal.offsetParent !== null &&
        document.body.contains(modal) &&
        (modal.innerText || "").includes("Resolve Issue");
      if (!modalStillVisible) {
        modalClosed = true;
        console.log(`[v11.9] ✓ Modal closed after ${(i + 1) * 200}ms - submission successful!`);
        break;
      }
    }

    // Fallback 1: form.submit()
    if (!modalClosed) {
      console.warn("[v11.9] Modal didn't close after 8s. Trying form.submit() fallback...");
      const form = resolveBtn.closest("form");
      if (form) {
        try {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form.submit?.();
          await sleep(3000);
          const stillOpen = modal.offsetParent !== null && (modal.innerText || "").includes("Resolve Issue");
          if (!stillOpen) { modalClosed = true; console.log("[v11.9] ✓ form.submit() worked!"); }
        } catch (e) { console.error("[v11.9] Form submit failed:", e); }
      }
    }

    // Fallback 2: Enter key press
    if (!modalClosed) {
      console.warn("[v11.9] Trying Enter key press...");
      resolveBtn.focus();
      ['keydown', 'keypress', 'keyup'].forEach(evt =>
        resolveBtn.dispatchEvent(new KeyboardEvent(evt, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
      );
      await sleep(3000);
      const stillOpen = modal.offsetParent !== null && (modal.innerText || "").includes("Resolve Issue");
      if (!stillOpen) { modalClosed = true; console.log("[v11.9] ✓ Enter key worked!"); }
    }

    // Fallback 3: elementFromPoint click (simulates real user click)
    if (!modalClosed) {
      console.warn("[v11.9] Trying elementFromPoint click...");
      const elAtPoint = document.elementFromPoint(clickX, clickY);
      if (elAtPoint) {
        elAtPoint.click();
        ['mousedown', 'mouseup', 'click'].forEach(evt =>
          elAtPoint.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY }))
        );
        await sleep(3000);
        const stillOpen = modal.offsetParent !== null && (modal.innerText || "").includes("Resolve Issue");
        if (!stillOpen) { modalClosed = true; console.log("[v11.9] ✓ elementFromPoint click worked!"); }
      }
    }

    const failed = results.filter(r => !r.ok);
    return {
      success: failed.length === 0 && modalClosed,
      message: !modalClosed
        ? `⚠ All fields filled but modal did NOT close after all attempts. Check for validation errors in SIM.`
        : failed.length === 0
          ? "✅ All fields filled and ticket resolved successfully"
          : `Filled ${results.length - failed.length}/${results.length}. Failed: ${failed.map(f => f.field).join(", ")}`,
      fieldResults: results,
      modalClosed
    };
  }

  function findLabelElement(modal, labelText) {
    const labelLower = labelText.toLowerCase();
    const candidates = [];
    modal.querySelectorAll("label, span, div, p, td, th").forEach(el => {
      let ownText = "";
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
      }
      ownText = ownText.trim().toLowerCase().replace(/[*?:]/g, "").trim();
      if (!ownText || ownText.length > 80) return;
      if (el.offsetParent === null) return;
      if (ownText === labelLower) {
        candidates.push({ el, score: 100 });
      } else if (ownText.startsWith(labelLower + " ") || ownText.startsWith(labelLower)) {
        candidates.push({ el, score: 80 });
      } else if (ownText.includes(labelLower)) {
        candidates.push({ el, score: 50 });
      }
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  function findInputNearLabel(labelEl, inputType) {
    if (!labelEl) return null;
    const selectorMap = {
      radio: "input[type='radio']",
      checkbox: "input[type='checkbox']",
      textarea: "textarea",
      select: "select",
      text: "input[type='text'], input[type='number'], input:not([type]):not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='submit']):not([type='button'])"
    };
    const selector = selectorMap[inputType] || "input, select, textarea";
    const matches = selector.split(",").map(s => s.trim());

    const root = labelEl.closest("[role='dialog'], .modal") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = labelEl;

    let current;
    let stepsSinceLabel = 0;
    while ((current = walker.nextNode())) {
      stepsSinceLabel++;
      if (stepsSinceLabel > 200) break;
      if (current.offsetParent === null) continue;
      for (const sel of matches) {
        try {
          if (current.matches(sel)) {
            const labelRect = labelEl.getBoundingClientRect();
            const inputRect = current.getBoundingClientRect();
            if (inputRect.top - labelRect.top > 400) return null;
            return current;
          }
        } catch (e) { }
      }
      if (current !== labelEl && current.tagName === "LABEL") {
        const nextLabelText = (current.innerText || "").trim();
        if (nextLabelText && nextLabelText.length > 2 && nextLabelText.length < 80) break;
      }
    }
    return null;
  }

  async function setRadioByLabel(modal, labelText, optionText) {
    const labelEl = findLabelElement(modal, labelText);
    if (!labelEl) { console.warn(`[v11.9] Radio label "${labelText}" not found`); return false; }
    let container = labelEl;
    for (let d = 0; d < 6 && container; d++) {
      const radios = Array.from(container.querySelectorAll("input[type='radio']"))
        .filter(r => r.offsetParent !== null);
      if (radios.length >= 2) {
        const optLower = optionText.toLowerCase();
        let target = radios.find(r => {
          const nearby = (r.parentElement?.innerText || r.closest("label")?.innerText || "").trim().toLowerCase();
          return nearby === optLower || nearby.startsWith(optLower) || r.value?.toLowerCase() === optLower;
        });
        if (!target) target = optLower === "no" ? radios[1] : radios[0];
        if (target) {
          target.focus();
          target.click();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
          if (setter) setter.call(target, true);
          ['change', 'click'].forEach(evt => target.dispatchEvent(new Event(evt, { bubbles: true })));
          console.log(`[v11.9] ✓ Radio "${labelText}" = ${optionText}`);
          return true;
        }
      }
      container = container.parentElement;
    }
    console.warn(`[v11.9] ✗ Radio "${labelText}" failed`);
    return false;
  }

  async function setTextareaByLabel(modal, labelText, value) {
    const labelEl = findLabelElement(modal, labelText);
    if (!labelEl) { console.warn(`[v11.9] Textarea label "${labelText}" not found`); return false; }
    labelEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(300);
    const textarea = findInputNearLabel(labelEl, "textarea");
    if (!textarea) { console.warn(`[v11.9] Textarea near "${labelText}" not found`); return false; }

    textarea.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(200);
    textarea.focus();
    textarea.click();

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, "");
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    if (setter) setter.call(textarea, value); else textarea.value = value;
    ['input', 'change', 'keyup', 'blur'].forEach(evt => textarea.dispatchEvent(new Event(evt, { bubbles: true })));

    await sleep(400);
    if (textarea.value === value) {
      console.log(`[v11.9] ✓ Textarea "${labelText}" = "${value.substring(0, 40)}" (verified)`);
      return true;
    }

    console.warn(`[v11.9] ⚠ Textarea "${labelText}" direct set failed. Char-by-char retry...`);
    textarea.focus();
    if (setter) setter.call(textarea, "");
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    for (const char of value) {
      const currentVal = textarea.value + char;
      if (setter) setter.call(textarea, currentVal); else textarea.value = currentVal;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(30);
    }
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(300);
    const finalOk = textarea.value === value;
    console.log(`[v11.9] ${finalOk ? '✓' : '✗'} Char-by-char "${labelText}" final = "${textarea.value.substring(0, 40)}"`);
    return finalOk;
  }

  async function setTextInputByLabel(modal, labelText, value) {
    const labelEl = findLabelElement(modal, labelText);
    if (!labelEl) { console.warn(`[v11.9] Text input label "${labelText}" not found`); return false; }
    labelEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(300);
    const input = findInputNearLabel(labelEl, "text");
    if (!input) { console.warn(`[v11.9] ✗ Text input near "${labelText}" not found`); return false; }

    const labelRect = labelEl.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    console.log(`[v11.9] "${labelText}" label Y=${Math.round(labelRect.top)}, input Y=${Math.round(inputRect.top)}, dist=${Math.round(inputRect.top - labelRect.top)}px`);

    input.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(200);
    input.focus();
    input.click();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, "");
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    if (setter) setter.call(input, String(value)); else input.value = String(value);
    ['input', 'change', 'keyup', 'blur'].forEach(evt => input.dispatchEvent(new Event(evt, { bubbles: true })));

    await sleep(300);
    if (input.value === String(value)) {
      console.log(`[v11.9] ✓ Text input "${labelText}" = "${value}" (verified)`);
      return true;
    }

    console.warn(`[v11.9] ⚠ "${labelText}" direct set failed. Char-by-char retry...`);
    input.focus();
    if (setter) setter.call(input, "");
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    for (const char of String(value)) {
      const currentVal = input.value + char;
      if (setter) setter.call(input, currentVal); else input.value = currentVal;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(50);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(200);
    const finalOk = input.value === String(value);
    console.log(`[v11.9] ${finalOk ? '✓' : '✗'} Char-by-char "${labelText}" final = "${input.value}"`);
    return finalOk;
  }

  async function setCheckboxByLabel(modal, checkboxLabelText) {
    const labelLower = checkboxLabelText.toLowerCase();
    const checkboxes = Array.from(modal.querySelectorAll("input[type='checkbox']"))
      .filter(c => c.offsetParent !== null);
    let target = null;
    for (const cb of checkboxes) {
      const nearby = (
        cb.parentElement?.innerText ||
        cb.closest("label, div, tr, td")?.innerText ||
        cb.nextSibling?.nodeValue || ""
      ).trim().toLowerCase();
      if (nearby.includes("zero out")) continue;
      if (nearby.includes(labelLower)) { target = cb; break; }
    }
    if (!target) { console.warn(`[v11.9] Checkbox "${checkboxLabelText}" not found`); return false; }
    target.focus();
    if (!target.checked) {
      target.click();
      if (!target.checked) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        if (setter) setter.call(target, true);
        ['change', 'click'].forEach(evt => target.dispatchEvent(new Event(evt, { bubbles: true })));
      }
    }
    console.log(`[v11.9] ✓ Checkbox "${checkboxLabelText}" checked`);
    return true;
  }

  async function setDropdownByLabel(modal, labelText, optionValue) {
    const labelEl = findLabelElement(modal, labelText);
    if (!labelEl) { console.warn(`[v11.9] Dropdown label "${labelText}" not found`); return false; }
    labelEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(300);
    const nativeSelect = findInputNearLabel(labelEl, "select");
    if (!nativeSelect || nativeSelect.tagName !== "SELECT") {
      console.warn(`[v11.9] No <select> near "${labelText}"`);
      return false;
    }
    nativeSelect.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(300);
    for (let i = 0; i < 15; i++) {
      if (nativeSelect.options && nativeSelect.options.length > 1) break;
      await sleep(200);
    }
    if (!nativeSelect.options || nativeSelect.options.length <= 1) {
      nativeSelect.focus();
      nativeSelect.click();
      ['mousedown', 'mouseup', 'focus', 'click'].forEach(evt =>
        nativeSelect.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
      );
      await sleep(1000);
      for (let i = 0; i < 10; i++) {
        if (nativeSelect.options && nativeSelect.options.length > 1) break;
        await sleep(200);
      }
    }
    const optCount = nativeSelect.options?.length || 0;
    console.log(`[v11.9] Dropdown "${labelText}" has ${optCount} options`);
    if (optCount <= 1) { console.warn(`[v11.9] ✗ "${labelText}" empty`); return false; }
    const ok = setNativeSelectValue(nativeSelect, optionValue);
    if (ok) console.log(`[v11.9] ✓ Dropdown "${labelText}" = "${optionValue}"`);
    else console.warn(`[v11.9] ✗ "${optionValue}" NOT in options for "${labelText}":`, Array.from(nativeSelect.options).map(o => o.text));
    return ok;
  }

  function setNativeSelectValue(selectEl, targetText) {
    const options = Array.from(selectEl.options || []);
    if (options.length === 0) return false;
    const targetLower = targetText.toLowerCase().trim();
    const targetClean = targetLower.replace(/[^a-z0-9]/g, "");
    let match = options.find(o => o.text.trim().toLowerCase() === targetLower)
      || options.find(o => o.value.trim().toLowerCase() === targetLower)
      || options.find(o => o.text.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === targetClean)
      || options.find(o => o.text.toLowerCase().includes(targetLower))
      || options.find(o => o.value.toLowerCase().includes(targetLower));
    if (!match) return false;
    selectEl.focus();
    if (selectEl._valueTracker) selectEl._valueTracker.setValue("");
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(selectEl, match.value); else selectEl.value = match.value;
    ['focus', 'input', 'change', 'blur'].forEach(evt => selectEl.dispatchEvent(new Event(evt, { bubbles: true })));
    return true;
  }

  async function waitForIssueSelected(issueId) {
    return waitFor(() => {
      const m = location.search.match(/selectedDocument=([a-f0-9-]{36})/i);
      return m && m[1].toLowerCase() === issueId.toLowerCase();
    }, 8000);
  }

  function waitFor(predicate, timeoutMs) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        try { if (predicate()) return resolve(true); } catch (e) { }
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(check, 300);
      };
      check();
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  window.__FBAMonitor = {
    getIssueCards, getCurrentSelectedUuid, extractDescriptionForUuid, extractRightPanelTitle,
    extractLeftPanelTitle, assignIssueToUser, fullAutoResolve, submitComment, markTicketAsResolved,
    fillAndSubmitResolveModal, applyLabelToTicket, scrollToResolveArea,
    findLabelElement, findInputNearLabel, setRadioByLabel, setTextareaByLabel,
    setTextInputByLabel, setCheckboxByLabel, setDropdownByLabel, setNativeSelectValue
  };
  console.log("[FBA Monitor CS v11.9] Debug helper: window.__FBAMonitor");
})();