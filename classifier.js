// Classifier engine - pure logic, no browser APIs
class IssueClassifier {
  constructor(rules) {
    this.rules = rules;
  }

  // Main entry point
  classify(issueText) {
    const normalized = (issueText || "").toLowerCase();

    // ═══ PRIORITY CHECK: Weight/Dimension/Fees → always Out of Scope ═══
    const feesOverride = this.checkFeesOverride(normalized);
    if (feesOverride) return feesOverride;

    // ═══ PRIORITY CHECK #2: EF Channel detection ═══
    const efResult = this.checkEFChannel(normalized);
    if (efResult) return efResult;

    const scores = [];

    for (const cat of this.rules.categories) {
      // Skip EF categories from normal scoring — they're handled above
      if (cat.isEFChannel) continue;
      const result = this.scoreCategory(cat, normalized);
      scores.push(result);
    }

    scores.sort((a, b) => b.score - a.score);
    const top = scores[0];
    const second = scores[1];

    // Fees redirect - special case
    if (top.category.action === "REDIRECT" && top.score >= 30) {
      return {
        status: "REDIRECT",
        category: top.category,
        score: top.score,
        message: `Fees issue - redirect to ${top.category.redirectTo}`,
        cti: top.category.cti
      };
    }

    // Ambiguous
    if (second && (top.score - second.score) < this.rules.ambiguityThreshold) {
      return {
        status: "AMBIGUOUS",
        top2: [top, second],
        message: `Cannot confidently classify. Top matches: ${top.category.name} (${top.score}) vs ${second.category.name} (${second.score})`
      };
    }

    // Unclassifiable
    if (top.score < this.rules.minConfidenceScore) {
      return {
        status: "UNCLASSIFIABLE",
        topGuess: top,
        message: "No category met minimum confidence threshold."
      };
    }

    return {
      status: "CLASSIFIED",
      category: top.category,
      score: top.score,
      signals: top.signals
    };
  }

  // ═══ EF Channel Detection ═══
  // Detects EasyShip/SellerFlex/MFN + SAFE-T tickets and classifies into sub-type
  checkEFChannel(text) {
    // Must have SAFE-T signal
    if (!(/\bsafe-?t\b/i.test(text))) return null;

    // Check for EF title patterns (strongest signal)
    const titlePatterns = this.rules.efTitlePatterns || [];
    let hasTitlePattern = false;
    for (const pattern of titlePatterns) {
      const flex = this.escapeRegex(pattern).replace(/\s+/g, "\\s+");
      if (new RegExp(flex, "i").test(text)) { hasTitlePattern = true; break; }
    }

    // Check for EF channel keywords
    const efKeywords = this.rules.efChannelKeywords || [];
    let hasEFSignal = false;
    for (const kw of efKeywords) {
      const flex = this.escapeRegex(kw).replace(/\s+/g, "\\s+");
      if (new RegExp(`\\b${flex}\\b`, "i").test(text)) { hasEFSignal = true; break; }
    }

    // Need EITHER a title pattern OR a channel keyword (plus SAFE-T)
    if (!hasTitlePattern && !hasEFSignal) return null;

    // Now determine sub-type by scoring EF categories
    const efCategories = (this.rules.categories || []).filter(c => c.isEFChannel);
    if (efCategories.length === 0) return null;

    let bestCat = null, bestScore = 0, bestSignals = [];
    for (const cat of efCategories) {
      const result = this.scoreCategory(cat, text);
      if (result.score > bestScore) {
        bestScore = result.score;
        bestCat = cat;
        bestSignals = result.signals;
      }
    }

    // If no strong match among sub-types, default to denial (most common)
    if (!bestCat || bestScore < 20) {
      bestCat = efCategories.find(c => c.efSubType === "denial") || efCategories[0];
      bestSignals = ["EF Channel + SAFE-T detected (default to denial sub-type)"];
    }

    return {
      status: "CLASSIFIED",
      category: bestCat,
      score: bestScore,
      signals: bestSignals,
      isEFChannel: true,
      message: `EF Channel (${bestCat.efSubType}) — requires Yoda lookup for assignment`
    };
  }

  checkFeesOverride(text) {
    const keywords = this.rules.feesOverrideKeywords || [];
    const matched = [];
    const lines = text.split(/\n/);
    const templateLineIndicators = ["select only one", "mfi /removal", "mfi/removal", "warehouse lost /fees", "removal order related"];
    // If the text has strong SAFE-T + EF signals, don't trigger fees override for clawback/claw back
    const hasSafetSignal = /\bsafe-?t\b/i.test(text);
    const hasEFSignal = /\b(easyship|easy\s*ship|seller\s*flex|sellerflex|mfn|self\s*ship|selfship)\b/i.test(text);
    const isEFContext = hasSafetSignal && hasEFSignal;

    for (const kw of keywords) {
      // Skip clawback/claw back keywords when in EF SAFE-T context
      if (isEFContext && (kw === "clawback" || kw === "claw back")) continue;

      const flex = this.escapeRegex(kw).replace(/\s+/g, "\\s+");
      const kwRe = new RegExp(`\\b${flex}\\b`, "i");
      let foundOnRealLine = false;
      for (const line of lines) {
        if (!kwRe.test(line)) continue;
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
    let score = 0;
    const signals = [];

    // Primary ID (+50)
    if (cat.primaryIdRegex) {
      const re = new RegExp(cat.primaryIdRegex, "i");
      if (re.test(text)) {
        score += 50;
        signals.push(`Primary ID field "${cat.primaryIdField}" found (+50)`);
      }
    }

    // Exclusive keywords (+15 each) - strong signal
    for (const kw of cat.exclusiveKeywords || []) {
      const flex = this.escapeRegex(kw).replace(/\s+/g, "\\s+");
      if (new RegExp(`\\b${flex}\\b`, "i").test(text)) {
        score += 15;
        signals.push(`Exclusive keyword "${kw}" (+15)`);
      }
    }

    // Regular keywords (+10 each)
    for (const kw of cat.keywords || []) {
      const flex = this.escapeRegex(kw).replace(/\s+/g, "\\s+");
      if (new RegExp(`\\b${flex}\\b`, "i").test(text)) {
        score += 10;
        signals.push(`Keyword "${kw}" (+10)`);
      }
    }

    // Field presence (+5 each)
    for (const field of (cat.mandatoryFields || []).concat(cat.optionalFields || [])) {
      const aliases = this.rules.fieldAliases[field] || [field.toLowerCase()];
      for (const alias of aliases) {
        const flex = this.escapeRegex(alias).replace(/\s+/g, "\\s+");
        if (new RegExp(`\\b${flex}\\b`, "i").test(text)) {
          score += 5;
          signals.push(`Field "${field}" mentioned (+5)`);
          break;
        }
      }
    }

    return { category: cat, score, signals };
  }

  // Check mandatory field presence + extract values
  checkMandatoryFields(issueText, category) {
    const result = { present: [], missing: [], values: {} };
    const lines = issueText.split(/\n+/);

    for (const field of category.mandatoryFields || []) {
      const aliases = this.rules.fieldAliases[field] || [field.toLowerCase()];
      let found = false;
      let value = null;

      for (const alias of aliases) {
        const flexAlias = this.escapeRegex(alias).replace(/\s+/g, "\\s+");
        const re = new RegExp(`(?:^|\\n)\\s*(?:\\d+\\s*[.:\\-]\\s*)?${flexAlias}(?:\\s+[\\w/()\\[\\]]+){0,4}\\s*[:\\-=\\u2013\\u2014]\\s*(.+?)$`, "im");
        for (const line of lines) {
          const m = line.match(re);
          if (m && m[1] && m[1].trim().length > 0 && !this.isPlaceholder(m[1])) {
            found = true;
            value = m[1].trim();
            break;
          }
        }
        if (found) break;
      }

      if (found) {
        result.present.push(field);
        result.values[field] = value;
      } else {
        result.missing.push(field);
      }
    }
    return result;
  }

  isPlaceholder(v) {
    const s = (v || "").trim().toLowerCase();
    return s === "" || s === "n/a" || s === "na" || s === "tbd" || s === "-" || s === "n" || s === "no" || s === "none" || s === "null";
  }

  escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

// Expose to background/content
if (typeof module !== "undefined") module.exports = IssueClassifier;
