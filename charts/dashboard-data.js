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

  // NOTE: these are the JS-side equivalents of the --color-yes/-no/-partial/
  // -empty/-other CSS custom properties in dashboard.css's `:root` block --
  // used here for the "Yes/No/To some extent/No data/Other" legend swatch
  // (renderCategoryLegend() in dashboard.js), which is built from a plain
  // JS-generated `style="background:...">` string rather than a CSS class,
  // so it can't just reference the CSS variable directly. Keep these two
  // in sync any time one changes -- `other` previously drifted out of sync
  // (still "#1565c0" blue here after --color-other was changed to teal in
  // CSS), leaving this legend showing the old color while every actual
  // chip using the CSS variable had already updated.
  var CATEGORY_COLORS = {
    yes: "#2e7d32",
    no: "#9e9e9e",
    partial: "#f9a825",
    empty: "#e0e0e0",
    other: "#00838f",
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

    // A value like "Yes, per self-report" or "No - see notes" is still a
    // definite Yes/No answer with extra explanatory text tacked on -- not
    // free text in the "other" sense, which should be reserved for values
    // that aren't a yes/no answer at all. Fall back to matching just the
    // *leading* word (e.g. "yes" out of "yes, based on chart review")
    // against the Yes/No sets above. Splitting on non-letter characters
    // (rather than just spaces) means punctuation like "Yes/No" or
    // "Yes(self-reported)" still isolates a clean leading word, and using
    // only the first word (not a substring match) means this doesn't
    // misfire on words that merely start with "yes"/"no", like "None" or
    // "Nonspecific" (those still resolve correctly above via the
    // whole-string checks, since "none" is itself a full entry in NO).
    var leadingWord = key.split(/[^a-z]+/)[0];
    if (YES.has(leadingWord)) return { category: "yes", label: label };
    if (NO.has(leadingWord)) return { category: "no", label: label };

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
  // Procedure Separation Type definitions (Cohort Summary row color /
  // Map marker color legend key -- see renderProcedureSeparationKey() in
  // dashboard.js). Kept here as plain data, alongside the other
  // classification/coloring constants above, rather than fetched from the
  // sheet, since these definitions are fixed regardless of which cohorts
  // are in the data.
  // ---------------------------------------------------------------------

  var PROCEDURE_SEPARATION_TYPE_DEFINITIONS = [
    {
      type: "Type 1",
      text: "Can isolate unilateral vs. bilateral oophorectomy vs. isolated hysterectomy via distinct, independent variables.",
    },
    {
      type: "Type 2",
      text: "Tracks hysterectomy and oophorectomy, but does not distinguish unilateral vs bilateral oophorectomy.",
    },
    {
      type: "Type 3",
      text: "Tracks either hysterectomy or oophorectomy only, does not include both as variables.",
    },
    {
      type: "Type 4",
      text: "Does not ask/track hysterectomy or oophorectomy as variables.",
    },
    {
      type: "Type 5",
      text: "Used intact uterine and/or ovarian status as an enrollment eligibility criterion; women with prior hysterectomy or oophorectomy were excluded from the sample rather than characterized within it.",
    },
  ];

  // Fixed Type -> color mapping, independent of which types are actually
  // present in any given subset of the data. Unlike PALETTE/paletteFor()
  // above (which assigns colors based on the sorted order of whichever
  // values happen to be present), this guarantees "Type 3" is always the
  // same color everywhere it shows up -- Cohort Summary rows, Map markers,
  // the Coverage Checklist matrix, and Custom Filter results -- even when
  // one tab's visible subset of cohorts happens to omit a type that
  // another tab's subset includes.
  var PROCEDURE_SEPARATION_TYPE_COLORS = {
    "Type 1": PALETTE[0],
    // Custom hex (not PALETTE[1] directly) -- a slightly darker red than
    // PALETTE[1]'s "#c62828" so it reads clearly apart from Type 5's
    // lighter magenta below rather than the two sitting at similar
    // lightness. Hardcoded here rather than changing PALETTE[1] itself so
    // any other, unrelated use of PALETTE[1] elsewhere isn't affected.
    "Type 2": "#8b1a1a",
    "Type 3": PALETTE[2],
    "Type 4": PALETTE[3],
    // Custom hex (not a PALETTE index) -- PALETTE[4] ("#6a1b9a", purple)
    // originally used here read too close to Type 1's blue at a glance, so
    // this was first swapped to PALETTE[8] ("#ad1457", pink/magenta).
    // That in turn read too close to Type 2's red once both are shown
    // side-by-side (e.g. in the checklist key), so it's now a lighter
    // magenta shade, kept apart from both blue and the darker red above.
    "Type 5": "#e63280",
  };

  // Row-tint overrides for the Cohort Summary / Coverage Checklist /
  // Custom Filter tables' "always-on" row background (see accent-row in
  // dashboard.css). Most types don't need an entry here -- the CSS just
  // derives a light pastel wash directly from PROCEDURE_SEPARATION_TYPE_
  // COLORS above via color-mix(). But mixing Type 2's dark red and Type
  // 5's magenta down to a ~15-18% tint with white desaturates both toward
  // the same washed-out grey-pink, since color-mix in sRGB loses
  // saturation fast at low percentages -- exactly the two colors that need
  // to stay visually distinct in their bold form (see the comments above)
  // also become the hardest pair to tell apart once pastel-ified. These
  // two hand-picked pastels keep Type 2's row wash reading warm/neutral
  // pink-red (equal green/blue) and Type 5's reading cooler/purpler (blue
  // > green), rather than leaving it to automatic mixing.
  var PROCEDURE_SEPARATION_TYPE_ROW_TINTS = {
    "Type 2": "#f3cccc",
    "Type 5": "#f8d3ef",
  };

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

  // ---------------------------------------------------------------------
  // Custom Filter: field kinds and operators
  // ---------------------------------------------------------------------
  // Each Custom Filter field gets only the operators that make sense for
  // its kind of value, instead of one shared list for every field:
  //   - "number":    numeric fields (N, % Female) -- compared as numbers
  //                  via parseNumeric(), so "~10,242" and "49.50%" work.
  //   - "age_range": Age Range -- "40-60", "~18-73", or open-ended "≥18".
  //   - "text":      still-free-text fields, searched by substring.
  //   - "category":  everything else (every Data Inventory item, Public
  //                  Availability, Country, Hysterectomy Inference Types,
  //                  ...) -- matched exactly against values picked from
  //                  the field's own list of existing values.
  // "Year Started/Wave Description" is text for now; once it's split into
  // a numeric year column and a wave description column, add the year
  // column to NUMBER_FIELDS.
  var NUMBER_FIELDS = ["Sample Size (N)", "% Female"];
  var AGE_RANGE_FIELDS = ["Age Range"];
  var TEXT_FIELDS = ["Year Started/Wave Description"];

  var OPERATORS_BY_KIND = {
    category: ["is", "is_not", "is_any_of"],
    number: ["greater_than", "less_than", "between"],
    age_range: ["includes_age", "min_age_at_least", "max_age_at_most"],
    text: ["contains", "not_contains"],
  };

  function fieldKind(field) {
    if (NUMBER_FIELDS.indexOf(field) !== -1) return "number";
    if (AGE_RANGE_FIELDS.indexOf(field) !== -1) return "age_range";
    if (TEXT_FIELDS.indexOf(field) !== -1) return "text";
    return "category";
  }

  function operatorsFor(field) {
    return OPERATORS_BY_KIND[fieldKind(field)];
  }

  /**
   * Parse an Age Range cell into {min, max}. Handles "40-60", "~18-73"
   * (the "~" is ignored), open-ended "≥18" / "18+" (max = Infinity),
   * "≤17" (min = 0), and a lone number (min = max). Returns null if no
   * number is present.
   */
  function parseAgeRange(value) {
    var s = value === null || value === undefined ? "" : String(value).replace(/,/g, "");
    var nums = (s.match(/\d+(\.\d+)?/g) || []).map(parseFloat);
    if (!nums.length) return null;
    if (nums.length >= 2) {
      return { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) };
    }
    if (/[≥>]|\+/.test(s)) return { min: nums[0], max: Infinity };
    if (/[≤<]/.test(s)) return { min: 0, max: nums[0] };
    return { min: nums[0], max: nums[0] };
  }

  function _norm(value) {
    return value === null || value === undefined ? "" : String(value).trim().toLowerCase();
  }

  function _valueList(value) {
    if (Array.isArray(value)) {
      return value.map(function (v) { return String(v).trim(); }).filter(Boolean);
    }
    var s = value === null || value === undefined ? "" : String(value).trim();
    return s ? [s] : [];
  }

  /**
   * True once a condition has everything its operator needs (a field, and
   * a value -- two values for "between"). Incomplete rows, like the blank
   * starter row, are skipped rather than filtering everything out.
   */
  function isConditionComplete(condition) {
    if (!condition || !condition.field || !condition.operator) return false;
    var values = _valueList(condition.value);
    if (condition.operator === "between") {
      return Array.isArray(condition.value) && condition.value.length === 2 &&
        !isNaN(parseNumeric(condition.value[0])) && !isNaN(parseNumeric(condition.value[1]));
    }
    return values.length > 0;
  }

  /**
   * Coerce a condition (e.g. from an older shared link, which used the
   * previous equals/contains/is-empty operators) onto an operator that's
   * valid for its field's kind. Returns null for conditions that no longer
   * have an equivalent (is empty / is not empty).
   */
  function normalizeCondition(condition) {
    if (!condition || typeof condition.field !== "string") return null;
    var field = condition.field;
    var kind = fieldKind(field);
    var op = condition.operator;
    var value = condition.value;
    if (op === "is_empty" || op === "is_not_empty") return null;

    if (OPERATORS_BY_KIND[kind].indexOf(op) === -1) {
      var legacy = {
        category: { equals: "is", contains: "is", not_equals: "is_not", not_contains: "is_not" },
        number: {},
        age_range: { contains: "includes_age", equals: "includes_age", greater_than: "min_age_at_least", less_than: "max_age_at_most" },
        text: { equals: "contains", not_equals: "not_contains" },
      }[kind];
      op = legacy[op] || OPERATORS_BY_KIND[kind][0];
    }

    if (op === "between") {
      value = Array.isArray(value) ? value.slice(0, 2).map(String) : ["", ""];
      while (value.length < 2) value.push("");
    } else if (op === "is_any_of") {
      value = _valueList(value);
    } else {
      value = Array.isArray(value) ? (value[0] || "") : (value === null || value === undefined ? "" : String(value));
    }
    return { field: field, operator: op, value: value };
  }

  /**
   * Evaluate a single (complete) condition against a record.
   * condition: { field, operator, value } -- value is a string, or an
   * array for "is_any_of" (picked values) and "between" ([low, high]).
   */
  function evaluateCondition(record, condition) {
    if (!isConditionComplete(condition)) return true;

    var raw = record ? record[condition.field] : undefined;
    var text = raw === null || raw === undefined ? "" : String(raw).trim();
    var value = condition.value;

    switch (condition.operator) {
      case "is":
        return _norm(text) === _norm(value);
      case "is_not":
        return _norm(text) !== _norm(value);
      case "is_any_of":
        return _valueList(value).some(function (v) { return _norm(v) === _norm(text); });
      case "contains":
        return _norm(text).indexOf(_norm(value)) !== -1;
      case "not_contains":
        return _norm(text).indexOf(_norm(value)) === -1;
      case "greater_than":
      case "less_than":
      case "between": {
        var n = parseNumeric(text);
        if (isNaN(n)) return false;
        if (condition.operator === "greater_than") return n > parseNumeric(value);
        if (condition.operator === "less_than") return n < parseNumeric(value);
        var lo = parseNumeric(value[0]);
        var hi = parseNumeric(value[1]);
        return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
      }
      case "includes_age":
      case "min_age_at_least":
      case "max_age_at_most": {
        var range = parseAgeRange(text);
        var age = parseNumeric(value);
        if (!range || isNaN(age)) return false;
        if (condition.operator === "includes_age") return age >= range.min && age <= range.max;
        if (condition.operator === "min_age_at_least") return range.min >= age;
        return range.max <= age;
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

  /**
   * Multiplier applied to a marker's base (N-derived) radius for the map's
   * current zoom level, relative to `referenceZoom` (the zoom level
   * markerRadius()'s pixel sizes are calibrated for -- i.e. scale is 1 when
   * zoom === referenceZoom). Grows/shrinks modestly per zoom step rather
   * than 1:1 with the tile grid's doubling pixel scale, and is clamped, so
   * relative sizing between cohorts (by N) stays legible at every zoom
   * level without markers either ballooning into huge circles when zoomed
   * in far or shrinking to an unreadable speck when zoomed out to the
   * whole world.
   */
  function zoomRadiusScale(zoom, referenceZoom) {
    var delta = (typeof zoom === "number" ? zoom : referenceZoom) - referenceZoom;
    return Math.max(0.5, Math.min(3, Math.pow(1.15, delta)));
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
    PROCEDURE_SEPARATION_TYPE_DEFINITIONS: PROCEDURE_SEPARATION_TYPE_DEFINITIONS,
    PROCEDURE_SEPARATION_TYPE_COLORS: PROCEDURE_SEPARATION_TYPE_COLORS,
    PROCEDURE_SEPARATION_TYPE_ROW_TINTS: PROCEDURE_SEPARATION_TYPE_ROW_TINTS,
    parseNumeric: parseNumeric,
    fieldKind: fieldKind,
    operatorsFor: operatorsFor,
    parseAgeRange: parseAgeRange,
    isConditionComplete: isConditionComplete,
    normalizeCondition: normalizeCondition,
    evaluateCondition: evaluateCondition,
    evaluateGroup: evaluateGroup,
    markerRadius: markerRadius,
    zoomRadiusScale: zoomRadiusScale,
    uniqueValues: uniqueValues,
    formatValue: formatValue,
    sortRecords: sortRecords,
  };
});
