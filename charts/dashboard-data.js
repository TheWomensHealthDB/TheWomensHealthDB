/*
 * dashboard-data.js
 *
 * Pure logic for the Women's Health Cohort Database dashboard: value
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
  // Numeric parsing (handles "1,234", "~500", " 42 ", etc.)
  // ---------------------------------------------------------------------

  function parseNumeric(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === "number") return value;
    var cleaned = String(value)
      .replace(/,/g, "")
      .replace(/~/g, "")
      .trim();
    if (cleaned === "") return NaN;
    var n = parseFloat(cleaned);
    return n;
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
        return text.toLowerCase() === target.trim().toLowerCase();
      case "not_equals":
        return text.toLowerCase() !== target.trim().toLowerCase();
      case "contains":
        return target.trim() === "" ? true : text.toLowerCase().indexOf(target.trim().toLowerCase()) !== -1;
      case "not_contains":
        return target.trim() === "" ? true : text.toLowerCase().indexOf(target.trim().toLowerCase()) === -1;
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
    if (isNaN(value) || value <= 0) return 6;
    return Math.max(6, Math.min(30, Math.sqrt(value) * 0.6));
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
