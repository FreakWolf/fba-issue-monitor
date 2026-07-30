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

    const scores = [];

    for (const cat of this.rules.categories) {
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

  checkFeesOverride(text) {
    const keywords = this.rules.feesOverrideKeywords || [];
    const matched = [];
    for (const kw of keywords) {
      const flex = this.escapeRegex(kw).replace(/\s+/g, "\\s+");
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
      const re = new RegExp(`\\b${this.escapeRegex(kw)}\\b`, "i");
      if (re.test(text)) {
        score += 15;
        signals.push(`Exclusive keyword "${kw}" (+15)`);
      }
    }

    // Regular keywords (+10 each)
    for (const kw of cat.keywords || []) {
      const re = new RegExp(`\\b${this.escapeRegex(kw)}\\b`, "i");
      if (re.test(text)) {
        score += 10;
        signals.push(`Keyword "${kw}" (+10)`);
      }
    }

    // Field presence (+5 each)
    for (const field of cat.mandatoryFields || []) {
      const aliases = this.rules.fieldAliases[field] || [field.toLowerCase()];
      for (const alias of aliases) {
        const re = new RegExp(`\\b${this.escapeRegex(alias)}\\b`, "i");
        if (re.test(text)) {
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
        const re = new RegExp(`${this.escapeRegex(alias)}\\s*[:\\-]\\s*(.+?)$`, "im");
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
    const s = v.trim().toLowerCase();
    return s === "" || s === "n/a" || s === "na" || s === "tbd" || s === "-";
  }

  escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

// Expose to background/content
if (typeof module !== "undefined") module.exports = IssueClassifier;