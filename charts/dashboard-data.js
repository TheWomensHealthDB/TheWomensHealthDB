/*
 * dashboard-data.js
 *
 * Pure logic for The Women's Health Database dashboard: value
 * classification, coloring, numeric parsing, filter evaluation, and marker
 * sizing. No DOM access here -- this module is usable both in Node (for
 * testing, via `require`) and in the browser (attaches to
 * `window.DashboardData`), following a small UMD-style wrapper.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DashboardData = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Value classification (yes / no / partial / empty / other)
  // ---------------------------------------------------------------------

  var YES = new Set(["yes", "y", "true", "included", "1"]);
  var NO = new Set(["no", "n", "false", "not included", "none", "0"]);
  var PARTIAL = new Set([
    "to some extent",
    "some",
    "partial",
    "partially",
    "somewhat",
    "sometimes",
    "limited",
    "mixed",
  ]);
  var EMPTY_ISH = new Set([
    "n/a",
    "na",
    "unknown",
    "unclear",
    "not applicable",
    "tbd",
    "pending",
  ]);

  var CATEGORY_COLORS = {
    yes: "#2e7d32",
    no: "#9e9e9e",
    partial: "#f9a825",
    empty: "#e0e0e0",
    other: "#1565c0",
  };

  /**
   * Classify a raw cell value into one of: yes, no, partial, empty, other.
   * Returns { category, label } where `label` is the original (trimmed)
   * text, suitable for a tooltip/title attribute.
   */
  function classifyValue(raw) {
    var label = raw === null || raw === undefined ? "" : String(raw).trim();

    if (label === "") {
      return { category: "empty", label: label };
    }

    var key = label.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

    if (YES.has(key)) return { category: "yes", label: label };
    if (NO.has(key)) return { category: "no", label: label };
    if (PARTIAL.has(key)) return { category: "partial", label: label };
    if (EMPTY_ISH.has(key)) return { category: "empty", label: label };

    return { category: "other", label: label };
  }

  // ---------------------------------------------------------------------
  // Categorical color palette (for map markers / legend, e.g. by
  // Procedure Separation Type)
  // ---------------------------------------------------------------------

  var PALETTE = [
    "#1565c0", // blue
    "#c62828", // red
    "#2e7d32", // green
    "#f9a825", // amber
    "#6a1b9a", // purple
    "#00838f", // teal
    "#ef6c00", // orange
    "#4e342e", // brown
    "#ad1457", // pink
    "#37474f", // blue-grey
  ];

  /**
   * Given an array of raw values, return a Map of unique-value -> color,
   * assigned deterministically (sorted order) so the same set of values
   * always maps to the same colors across renders.
   */
  function paletteFor(values) {
    var unique = Array.from(
      new Set(
        (values || [])
          .map(function (v) {
            return v === null || v === undefined ? "" : String(v).trim();
          })
          .filter(function (v) {
            return v !== "";
          })
      )
    ).sort();

    var map = new Map();
    unique.forEach(function (val, i) {
      map.set(val, PALETTE[i % PALETTE.length]);
    });
    return map;
  }

  // ---------------------------------------------------------------------
  // Numeric parsing (handles "1,234", "~500", "N=120", "45%", etc.)
  // ---------------------------------------------------------------------

  function parseNumeric(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === "number") return value;
    // Pull the first numeric token out of the string rather than requiring
    // the *whole* string to be a bare number. This tolerates the kind of
    // inconsistent formatting that shows up in a hand-maintained
    // spreadsheet -- "~500", "N=120", "45%", "1,234 participants" all
    // resolve to their number instead of NaN.
    // The `(?<!\d)` lookbehind keeps a hyphen from being misread as a
    // minus sign when it's actually a range separator glued to the
    // previous number, e.g. the "-" in "40-60" should not turn "60" into
    // "-60" the way a plain `-?\d+` pattern would.
    var cleaned = String(value).replace(/,/g, "");
    var match = cleaned.match(/(?<!\d)-?\d+(\.\d+)?/);
    if (!match) return NaN;
    return parseFloat(match[0]);
  }

  /**
   * Pull every numeric token out of a string, in order. Used for
   * loosely-formatted "pair" or "range" fields like Age Range ("40-60")
   * or %male/%female ("0/100"). See parseNumeric() above for why the
   * regex excludes a "-" immediately after another digit.
   */
  function _extractNumbers(value) {
    var s = value === null || value === undefined ? "" : String(value).replace(/,/g, "");
    var matches = s.match(/(?<!\d)-?\d+(\.\d+)?/g);
    if (!matches) return [];
    return matches.map(function (m) {
      return parseFloat(m);
    });
  }

  /**
   * Lowercase + strip common formatting noise (%, ~, =, commas, stray
   * punctuation) so values like "45%" and "45", or "N = 120" and "120",
   * compare equal. Hyphens, slashes, and periods are kept since they're
   * meaningful inside ranges/decimals (e.g. "40-60", "0/100").
   */
  function _normalizeLoose(value) {
    var s = value === null || value === undefined ? "" : String(value);
    s = s.toLowerCase();
    s = s.replace(/[%~=]/g, " ");
    s = s.replace(/,/g, "");
    s = s.replace(/[^a-z0-9\s\-\/.]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  /** Classic Levenshtein (edit) distance between two strings. */
  function _levenshtein(a, b) {
    if (a === b) return 0;
    var al = a.length,
      bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    var prev = new Array(bl + 1);
    var curr = new Array(bl + 1);
    for (var j = 0; j <= bl; j++) prev[j] = j;
    for (var i = 1; i <= al; i++) {
      curr[0] = i;
      for (var k = 1; k <= bl; k++) {
        var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
        curr[k] = Math.min(curr[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
      }
      var tmp = prev;
      prev = curr;
      curr = tmp;
    }
    return prev[bl];
  }

  /**
   * True if two already-normalized *whole-value* strings are the same or
   * a small edit-distance apart (scaled to length, so short fields like
   * "Yes"/"No" don't get too loose while longer free-text fields tolerate
   * a couple of character-level typos/differences). Deliberately does NOT
   * treat "one contains the other" as a match -- that's too loose for an
   * "equals" comparison (e.g. a search for "100" shouldn't equals-match a
   * cell of "0/100"; that's what the "contains" operator is for).
   */
  function _closeEnoughStrict(a, b) {
    if (a === b) return true;
    if (a === "" || b === "") return false;
    var maxLen = Math.max(a.length, b.length);
    var threshold = maxLen <= 4 ? 1 : Math.max(1, Math.round(maxLen * 0.2));
    return _levenshtein(a, b) <= threshold;
  }

  /**
   * Same idea as _closeEnoughStrict, but also treats one string containing
   * the other as a match. Used for word/token-level fuzzy fallback inside
   * "contains", where substring containment is exactly what's wanted.
   */
  function _closeEnough(a, b) {
    if (a === b) return true;
    if (a === "" || b === "") return false;
    if (a.length >= 3 && b.length >= 3 && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1)) {
      return true;
    }
    var maxLen = Math.max(a.length, b.length);
    var threshold = maxLen <= 4 ? 1 : Math.max(1, Math.round(maxLen * 0.2));
    return _levenshtein(a, b) <= threshold;
  }

  /**
   * Tolerant "equals": exact match first, then formatting-normalized
   * match, then numeric-set match (so "100" matches a cell of "0/100",
   * "40-60" matches "40 to 60 years", etc.), then a fuzzy fallback for
   * typos/small differences.
   */
  function _matchesEquals(text, target) {
    var t = target.trim();
    if (t === "") return text.trim() === "";
    if (text.trim().toLowerCase() === t.toLowerCase()) return true;

    var normText = _normalizeLoose(text);
    var normTarget = _normalizeLoose(t);
    if (normText === normTarget) return true;

    var numsText = _extractNumbers(text);
    var numsTarget = _extractNumbers(t);
    if (numsText.length && numsTarget.length && numsText.length === numsTarget.length) {
      var allMatch = numsTarget.every(function (nt) {
        return numsText.some(function (n) {
          return Math.abs(n - nt) < 1e-9;
        });
      });
      if (allMatch) return true;
    }

    return _closeEnoughStrict(normText, normTarget);
  }

  /**
   * True if a string has a "40-60" / "40 to 60" / "40 through 60" style
   * continuous range somewhere in it. Deliberately excludes "/"-separated
   * pairs like "0/100" (%male/%female) -- those are two discrete values,
   * not a continuous range, so "does 55 fall between 0 and 100" would be
   * true for almost every cohort and not a meaningful match.
   */
  function _looksLikeRange(text) {
    return /\d\s*(-|to|through)\s*\d/i.test(text);
  }

  /**
   * Tolerant "contains": plain substring first, then formatting-normalized
   * substring, then numeric-aware matching (a bare number matches if it
   * equals one of the field's numbers, or -- only for genuine ranges like
   * Age Range's "40-60", not discrete pairs like %male/%female's "0/100"
   * -- falls between the two numbers), then a fuzzy word-level fallback
   * for typos.
   */
  function _matchesContains(text, target) {
    var t = target.trim();
    if (t === "") return true;

    var lowerText = text.toLowerCase();
    var lowerTarget = t.toLowerCase();
    if (lowerText.indexOf(lowerTarget) !== -1) return true;

    var normText = _normalizeLoose(text);
    var normTarget = _normalizeLoose(t);
    if (normTarget !== "" && normText.indexOf(normTarget) !== -1) return true;

    var numTarget = parseNumeric(t);
    var numsText = _extractNumbers(text);
    if (!isNaN(numTarget) && numsText.length) {
      if (numsText.some(function (n) { return Math.abs(n - numTarget) < 1e-9; })) return true;
      if (numsText.length === 2 && _looksLikeRange(text)) {
        var lo = Math.min(numsText[0], numsText[1]);
        var hi = Math.max(numsText[0], numsText[1]);
        if (numTarget >= lo && numTarget <= hi) return true;
      }
    }

    if (normTarget.length >= 3) {
      var tokens = normText.split(/[\s\-\/]+/).filter(Boolean);
      for (var i = 0; i < tokens.length; i++) {
        if (_closeEnough(tokens[i], normTarget)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Filter condition evaluation (AND/OR builder)
  // ---------------------------------------------------------------------

  var OPERATORS = [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "greater_than",
    "less_than",
    "is_empty",
    "is_not_empty",
  ];

  function _fieldText(record, field) {
    var raw = record ? record[field] : undefined;
    return raw === null || raw === undefined ? "" : String(raw).trim();
  }

  /**
   * Evaluate a single condition against a record.
   * condition: { field, operator, value }
   */
  function evaluateCondition(record, condition) {
    if (!condition || !condition.field || !condition.operator) return true;

    var text = _fieldText(record, condition.field);
    var op = condition.operator;
    var target = condition.value === null || condition.value === undefined ? "" : String(condition.value);

    switch (op) {
      case "is_empty":
        return text === "";
      case "is_not_empty":
        return text !== "";
      case "equals":
        return _matchesEquals(text, target);
      case "not_equals":
        return !_matchesEquals(text, target);
      case "contains":
        return _matchesContains(text, target);
      case "not_contains":
        return target.trim() === "" ? true : !_matchesContains(text, target);
      case "greater_than": {
        var a = parseNumeric(text);
        var b = parseNumeric(target);
        if (isNaN(a) || isNaN(b)) return false;
        return a > b;
      }
      case "less_than": {
        var a2 = parseNumeric(text);
        var b2 = parseNumeric(target);
        if (isNaN(a2) || isNaN(b2)) return false;
        return a2 < b2;
      }
      default:
        return true;
    }
  }

  /**
   * Evaluate a group of conditions against a record.
   * mode: 'all' (AND) or 'any' (OR). Empty condition list => true (no filter).
   */
  function evaluateGroup(record, conditions, mode) {
    if (!conditions || conditions.length === 0) return true;
    if (mode === "any") {
      return conditions.some(function (c) {
        return evaluateCondition(record, c);
      });
    }
    return conditions.every(function (c) {
      return evaluateCondition(record, c);
    });
  }

  // ---------------------------------------------------------------------
  // Map marker sizing
  // ---------------------------------------------------------------------

  /**
   * Sqrt-scaled marker radius (pixels) from a cohort's N, clamped to a
   * sane visual range so very large/small cohorts don't dominate or
   * disappear.
   */
  function markerRadius(n) {
    var value = parseNumeric(n);
    if (isNaN(value) || value <= 0) return 4;
    return Math.max(4, Math.min(20, Math.sqrt(value) * 0.42));
  }

  // ---------------------------------------------------------------------
  // Misc table helpers
  // ---------------------------------------------------------------------

  function uniqueValues(records, column) {
    var set = new Set();
    (records || []).forEach(function (r) {
      var v = r ? r[column] : undefined;
      if (v !== null && v !== undefined && String(v).trim() !== "") {
        set.add(String(v).trim());
      }
    });
    return Array.from(set).sort();
  }

  function formatValue(v) {
    if (v === null || v === undefined) return "";
    var s = String(v).trim();
    return s === "" ? "\u2014" : s; // em dash for empty
  }

  /**
   * Sort an array of records by a column. direction: 'asc' | 'desc'.
   * Numeric-aware: if both values parse as numbers, compares numerically;
   * otherwise falls back to case-insensitive string comparison. Empty
   * values always sort to the end regardless of direction.
   */
  function sortRecords(records, column, direction) {
    var dir = direction === "desc" ? -1 : 1;
    var copy = (records || []).slice();

    copy.sort(function (ra, rb) {
      var a = ra ? ra[column] : undefined;
      var b = rb ? rb[column] : undefined;
      var aEmpty = a === null || a === undefined || String(a).trim() === "";
      var bEmpty = b === null || b === undefined || String(b).trim() === "";

      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;

      var aNum = parseNumeric(a);
      var bNum = parseNumeric(b);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return dir * (aNum - bNum);
      }

      var aStr = String(a).toLowerCase();
      var bStr = String(b).toLowerCase();
      if (aStr < bStr) return -1 * dir;
      if (aStr > bStr) return 1 * dir;
      return 0;
    });

    return copy;
  }

  return {
    classifyValue: classifyValue,
    CATEGORY_COLORS: CATEGORY_COLORS,
    PALETTE: PALETTE,
    paletteFor: paletteFor,
    parseNumeric: parseNumeric,
    OPERATORS: OPERATORS,
    evaluateCondition: evaluateCondition,
    evaluateGroup: evaluateGroup,
    markerRadius: markerRadius,
    uniqueValues: uniqueValues,
    formatValue: formatValue,
    sortRecords: sortRecords,
  };
});
