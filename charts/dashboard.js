/*
 * dashboard.js
 *
 * DOM rendering + event wiring for The Women's Health Database
 * dashboard. Depends on `window.DashboardData` (dashboard-data.js) for
 * pure logic, and the global Leaflet `L` object (loaded via CDN in
 * index.html) for the map tab. Reads pre-generated JSON
 * (charts/data/cohorts.json, charts/data/schema.json) -- no backend.
 */
(function () {
  "use strict";

  var DD = window.DashboardData;

  var state = {
    cohorts: [],
    schema: null,
    mapInitialized: false,
    map: null,
    mapLayer: null,
    mapMarkerGroups: null, // [{centroid, entries:[{marker, radius, angle}]}]
    // Table 1
    // `column: null` here just means "not yet decided" -- each table
    // defaults its own sort to alphabetical-by-cohort-name the first time
    // it renders (see the "Sortable table headers" section below), rather
    // than being initialized to the cohort name column directly here,
    // since the column's actual field key isn't known until the schema
    // has loaded.
    t1Sort: { column: null, direction: "asc" },
    t1Rendered: false, // see loadData()/wireTabs() -- deferred until the tab is visible
    // Table 2
    t2SelectedCohorts: null, // Set, populated once data loads
    // Set of the 11 domain rollup labels currently shown as columns --
    // starts with all of them selected (see loadData()), and the
    // "Domains" picker toggles individual ones off/on.
    t2SelectedDomains: null,
    // Set of individually-drilled-into leaf checklist items -- starts empty
    // so the matrix opens showing just the 11 umbrella-category rollup
    // columns (see checklistCategoryRollups()); checking specific items in
    // the "Checklist items" picker adds their own columns alongside those.
    t2SelectedColumns: null,
    t2Rendered: false, // see loadData()/wireTabs() -- deferred until the tab is visible
    t2Sort: { column: null, direction: "asc" },
    // Table 3
    t3Conditions: [], // [{id, field, operator, value}]
    t3Mode: "all",
    t3ConditionIdSeq: 1,
    t3Rendered: false, // see loadData()/wireTabs() -- deferred until the tab is visible
    t3Sort: { column: null, direction: "asc" },
  };

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", function () {
    wireTabs();
    wireInPageTabLinks();
    wireModal();
    wireTableZoom();
    wireTableExport();
    renderAllProcedureSeparationKeys();

    // A shared Custom Filter link (see buildShareableFilterURL()) --
    // applied here, before loadData() below, so renderTable3Fields()'s own
    // "start with one blank condition" fallback naturally never fires
    // (state.t3Conditions is already non-empty by the time it checks).
    // Independent of the cohorts/schema fetch itself -- just reads the
    // page's own URL -- so there's no need to wait for loadData() first.
    var sharedFilter = parseSharedFilterFromURL();
    if (sharedFilter) {
      state.t3Conditions = sharedFilter.conditions;
      state.t3Mode = sharedFilter.mode;
      var modeSelect = document.getElementById("t3-mode");
      if (modeSelect) modeSelect.value = state.t3Mode;
      // Jump straight to Custom Filter so the shared setup is immediately
      // visible rather than landing on Information as usual -- reuses the
      // same nav.tabs button wireTabs() above already wired, so every
      // side effect of a real tab switch happens exactly as it would from
      // a direct click.
      var filterBtn = document.querySelector('nav.tabs button[data-tab="filter"]');
      if (filterBtn) filterBtn.click();
    }

    loadData();
  });

  function loadData() {
    Promise.all([
      fetch("data/cohorts.json").then(function (r) {
        if (!r.ok) throw new Error("Failed to load cohorts.json (" + r.status + ")");
        return r.json();
      }),
      fetch("data/schema.json").then(function (r) {
        if (!r.ok) throw new Error("Failed to load schema.json (" + r.status + ")");
        return r.json();
      }),
    ])
      .then(function (results) {
        state.cohorts = results[0] || [];
        state.schema = results[1] || {};
        state.t2SelectedCohorts = new Set(
          state.cohorts.map(function (c) {
            return c[state.schema.cohort_name_column];
          })
        );
        // All 11 domains start selected -- see the comment on
        // t2SelectedDomains in `state` above.
        state.t2SelectedDomains = new Set(
          checklistCategoryRollups().map(function (r) {
            return r.label;
          })
        );
        // Starts empty -- see the comment on t2SelectedColumns in `state`
        // above -- rather than every checklist_columns entry.
        state.t2SelectedColumns = new Set();

        renderDataSourceBanner();
        renderTable3Fields();

        // Table 1 (Cohort Summary), Table 2 (Coverage Checklist), and
        // Table 3 (Custom Filter) all build tables with `position: sticky`
        // header cells (see dashboard.css). Building sticky-positioned
        // cells while their tab panel is still `display: none` (every tab
        // except the default "Information" one) leaves the browser's
        // sticky-offset calculations stale -- the header ends up rendered
        // behind the body and only self-corrects for a flash on hover,
        // never staying fixed. So, same as the Map tab's initMap() below,
        // defer actually building these tables' DOM until their tab is
        // first shown (see wireTabs()), and only build eagerly here if
        // that tab happens to already be the active one on load.
        var summaryPanel = document.getElementById("panel-summary");
        if (summaryPanel && summaryPanel.classList.contains("active")) {
          renderTable1();
          state.t1Rendered = true;
        }
        var checklistPanel = document.getElementById("panel-checklist");
        if (checklistPanel && checklistPanel.classList.contains("active")) {
          renderTable2();
          state.t2Rendered = true;
        }
        var filterPanel = document.getElementById("panel-filter");
        if (filterPanel && filterPanel.classList.contains("active")) {
          renderTable3();
          state.t3Rendered = true;
        }

        // Map is initialized lazily when its tab is first shown (see wireTabs),
        // but if the Map tab happens to already be active on load, init now.
        var mapPanel = document.getElementById("panel-map");
        if (mapPanel && mapPanel.classList.contains("active")) {
          initMap();
        }
      })
      .catch(function (err) {
        console.error(err);
        // Information and Items Reference are both static markup with no
        // cohort-data dependency (see their sections in index.html), so
        // they're excluded here and stay usable even when the data fetch
        // below fails.
        document
          .querySelectorAll(".tab-panel:not(#panel-information):not(#panel-items-reference)")
          .forEach(function (panel) {
            panel.innerHTML =
              '<p class="empty-state">Could not load cohort data (' +
              escapeHtml(err.message) +
              "). If you're viewing this locally, make sure charts/data/*.json exist " +
              "(run fetch_data.py) and that you're serving the charts/ folder over HTTP, " +
              "not opening index.html directly as a file.</p>";
          });
      });
  }

  // ---------------------------------------------------------------------
  // Data-source banner (surfaces when the site is running on sample/mock
  // data instead of the live spreadsheet, e.g. because GOOGLE_CREDENTIALS
  // / SPREADSHEET_ID aren't reaching the build -- previously this was only
  // visible by comparing values against the mock dataset by eye).
  // ---------------------------------------------------------------------

  function renderDataSourceBanner() {
    var el = document.getElementById("data-source-banner");
    if (!el) return;
    if (state.schema && state.schema.is_mock_data) {
      el.innerHTML =
        "<strong>Heads up:</strong> this page is showing sample placeholder data, " +
        "not your live spreadsheet. That usually means the GOOGLE_CREDENTIALS and/or " +
        "SPREADSHEET_ID secrets aren't reaching the build. Check Settings \u2192 Secrets " +
        "and variables \u2192 Actions in your GitHub repo, then re-run the workflow.";
      el.classList.add("visible");
    } else {
      el.classList.remove("visible");
      el.innerHTML = "";
    }
  }

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------

  function wireTabs() {
    var buttons = document.querySelectorAll("nav.tabs button");
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = btn.getAttribute("data-tab");

        // Matched by data-tab value, not by "b === btn" identity: the
        // Women's Health Data Inventory / Items Reference dropdown group
        // (see ".nav-item-group" in index.html) has *two* buttons sharing
        // data-tab="checklist" -- the always-visible one and the
        // dropdown's own copy of it -- and both need to show active
        // together regardless of which one was actually clicked.
        buttons.forEach(function (b) {
          b.classList.toggle("active", b.getAttribute("data-tab") === target);
        });
        // Items Reference has no top-level button of its own (see
        // ".nav-item-group" in index.html) -- landing on it via its
        // dropdown entry would otherwise leave the whole nav bar showing
        // nothing highlighted. Marking the group itself lets the always-
        // visible "Women's Health Data Inventory" button show a lighter
        // "you're somewhere in here" indicator (see ".nav-item-group.
        // group-active" in dashboard.css) instead of full active styling,
        // which would wrongly claim you're on that exact tab.
        document.querySelectorAll(".nav-item-group").forEach(function (group) {
          var inGroup = Array.prototype.some.call(group.querySelectorAll("button"), function (b) {
            return b.getAttribute("data-tab") === target;
          });
          group.classList.toggle("group-active", inGroup);
        });
        document.querySelectorAll(".tab-panel").forEach(function (panel) {
          panel.classList.toggle("active", panel.id === "panel-" + target);
        });

        if (target === "map" && !state.mapInitialized && state.cohorts.length) {
          initMap();
        } else if (state.map) {
          // Leaflet needs a nudge when its container was previously hidden.
          setTimeout(function () {
            state.map.invalidateSize();
          }, 0);
        }

        // Same deferred-build reasoning as the Map tab above -- see the
        // comment in loadData() for why Table 1/2/3 can't be safely built
        // while their panel is still display:none.
        if (target === "summary" && !state.t1Rendered && state.cohorts.length) {
          renderTable1();
          state.t1Rendered = true;
        }
        if (target === "checklist" && !state.t2Rendered && state.cohorts.length) {
          renderTable2();
          state.t2Rendered = true;
        }
        if (target === "filter" && !state.t3Rendered && state.cohorts.length) {
          renderTable3();
          state.t3Rendered = true;
        }

        // Landscape-phone/small-tablet sidebar height sync (see
        // syncLandscapeChecklistHeight() below) needs to (re)run every time
        // the Women's Health Data Inventory tab becomes visible, not just
        // the first time it's rendered -- its measurements are all 0 while
        // the panel is display:none, so switching *back* to an
        // already-rendered tab needs its own fresh run too. Deferred with
        // the same 0ms setTimeout as the Map's invalidateSize() above, so
        // the panel's just-applied "active" class has actually taken effect
        // (and the panel is laid out/visible) before measuring it.
        if (target === "checklist") {
          setTimeout(function () {
            syncLandscapeChecklistHeight();
          }, 0);
        }
      });
    });

    // Re-run on resize/orientationchange too -- rotating a phone or
    // resizing a browser window can cross in or out of the 641-900px
    // range this applies to, or change the table's rendered height while
    // already inside it. Debounced so a drag-resize doesn't thrash layout
    // on every intermediate pixel.
    //
    // NOTE: a `ResizeObserver` watching `document.documentElement` was
    // tried here briefly to cover the case of switching between named
    // device presets in Chrome DevTools' device toolbar (which doesn't
    // reliably dispatch a plain `resize` event) but that caused a real
    // feedback loop: syncLandscapeChecklistHeight() below changes the
    // sidebar pickers' *heights*, which can be just enough to toggle the
    // page's vertical scrollbar on/off, which shifts the viewport's
    // available *width* by the scrollbar's width, which the observer picks
    // up as "the size changed" and reruns the same height calculation
    // again -- an infinite oscillation that showed up as constant
    // flashing and the table's horizontal scroll position getting yanked
    // back to the left on every cycle. Reverted back to plain `resize`/
    // `orientationchange` listeners, which don't have that self-triggering
    // problem (they only fire for genuine browser-driven size changes, not
    // ones caused by this code's own DOM writes).
    var landscapeSyncTimer = null;
    // Mobile browsers (notably iOS Safari) also fire "resize" whenever
    // their own UI chrome -- the URL bar -- collapses or expands during
    // scrolling, which changes window.innerHEIGHT but not innerWIDTH. This
    // code only ever cares about width (the 641-900px breakpoint), so that
    // kind of resize is just noise -- but every one of those otherwise
    // still re-ran the full picker-height recalculation below, which
    // visibly "flashed" the sidebar as it cleared and reapplied its
    // heights. That was especially noticeable on the Coverage Checklist
    // tab specifically, since its table can be wider *and* taller than the
    // screen (every other tab's content fits without needing to scroll),
    // making it the one tab where zooming out and scrolling around keeps
    // tripping the URL-bar chrome toggle repeatedly. Tracking the last
    // width this actually synced against and skipping the work entirely
    // when the width hasn't changed avoids all of that redundant churn.
    var lastLandscapeSyncWidth = null;
    window.addEventListener("resize", function () {
      clearTimeout(landscapeSyncTimer);
      landscapeSyncTimer = setTimeout(function () {
        if (window.innerWidth === lastLandscapeSyncWidth) return;
        lastLandscapeSyncWidth = window.innerWidth;
        syncLandscapeChecklistHeight();
      }, 120);
    });
    window.addEventListener("orientationchange", function () {
      setTimeout(function () {
        lastLandscapeSyncWidth = window.innerWidth;
        syncLandscapeChecklistHeight();
      }, 150);
    });
  }

  // In-page links that jump to another tab -- the Information tab's
  // Procedure Separation Type explanation pointing over to its dedicated
  // info tab (".tab-link"), and the header logo/title acting as a "go
  // home" link back to Information (".brand-home-link"). Rather than
  // duplicating wireTabs()'s tab-switch logic, this just clicks the
  // matching nav.tabs button so every side effect of a real tab switch
  // (active-state highlighting, lazy table/map rendering, etc.) happens
  // exactly as it would from a direct click. `preventDefault()` covers
  // ".brand-home-link", a real `<a href="#">` (needed so it reads as a
  // link and gets keyboard/middle-click support) that would otherwise also
  // jump the page to the top and add a stray "#" to the URL.
  function wireInPageTabLinks() {
    document
      .querySelectorAll(".tab-link[data-goto-tab], .brand-home-link[data-goto-tab]")
      .forEach(function (link) {
        link.addEventListener("click", function (event) {
          event.preventDefault();
          var target = link.getAttribute("data-goto-tab");
          var btn = document.querySelector('nav.tabs button[data-tab="' + target + '"]');
          if (btn) btn.click();
        });
      });
  }

  // ---------------------------------------------------------------------
  // Table zoom ("Table size" +/- control -- shared by Hysterectomy
  // Inference Classification, Women's Health Data Inventory, and Custom
  // Filter; see ".table-zoom" in index.html/dashboard.css)
  // ---------------------------------------------------------------------
  // Purely a font-size multiplier, applied as an inline "--table-zoom"
  // custom property directly on the relevant <table> element -- every
  // column width/padding throughout these tables is already sized in "em"
  // (relative to the table's own font-size; see "table.data-table" and
  // ".narrow-col-header" in dashboard.css), so scaling that one property
  // simultaneously shrinks/grows the text *and* every column's width
  // together: zooming out fits more columns on screen at a smaller size,
  // zooming in shows fewer of them at a larger one.
  var TABLE_ZOOM_MIN = 60;
  var TABLE_ZOOM_MAX = 160;
  var TABLE_ZOOM_STEP = 10;
  function wireTableZoom() {
    document.querySelectorAll(".table-zoom").forEach(function (control) {
      var table = document.getElementById(control.getAttribute("data-table"));
      var outBtn = control.querySelector(".table-zoom-out");
      var inBtn = control.querySelector(".table-zoom-in");
      var pctEl = control.querySelector(".table-zoom-pct");
      if (!table || !outBtn || !inBtn || !pctEl) return;

      var level = 100;

      function apply() {
        table.style.setProperty("--table-zoom", level / 100);
        pctEl.textContent = level + "%";
        outBtn.disabled = level <= TABLE_ZOOM_MIN;
        inBtn.disabled = level >= TABLE_ZOOM_MAX;
      }

      outBtn.addEventListener("click", function () {
        level = Math.max(TABLE_ZOOM_MIN, level - TABLE_ZOOM_STEP);
        apply();
      });
      inBtn.addEventListener("click", function () {
        level = Math.min(TABLE_ZOOM_MAX, level + TABLE_ZOOM_STEP);
        apply();
      });
      // Clicking the percentage readout itself resets to 100% -- a
      // lightweight built-in reset without needing a dedicated button.
      pctEl.title = "Click to reset to 100%";
      pctEl.addEventListener("click", function () {
        level = 100;
        apply();
      });

      apply();
    });
  }

  // ---------------------------------------------------------------------
  // Table export (CSV / Excel / PDF)
  // ---------------------------------------------------------------------

  // Human-readable title for a table id, used as the PDF export's own
  // on-page heading. CSV/Excel have no such heading -- the filename
  // (each ".table-export"'s own data-filename) already carries this.
  var TABLE_EXPORT_TITLES = {
    "t1-table": "Hysterectomy Inference Classification",
    "t2-table": "Women's Health Data Inventory",
    "t3-table": "Custom Filter",
  };

  // Strips the soft hyphens narrow column headers use to hint mid-word
  // line breaks (see softHyphenateLabel()) -- meaningless outside that
  // specific visual context -- and collapses any stray whitespace left
  // over from reading text out of a rendered DOM cell.
  function cleanExportText(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/\u00ad/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Reads whatever a table's own render function (renderTable1Body() /
  // renderTable2Body() / renderTable3()) has already put in the live DOM
  // -- the same headers, columns, rows, sort order, and filtering the
  // user is currently looking at -- rather than recomputing any of that
  // independently, so every export is guaranteed to match the current
  // on-screen view exactly (per-table column selection, search/filter
  // conditions, cohort selection, and sort order all included for free).
  // A cell can opt out of its own literal textContent via a
  // `data-export-value` attribute set at render time -- see
  // renderTable2Body()'s chip cells, whose visible glyph (Y/N/~/T) is far
  // too compact on its own to be useful in an exported file.
  function collectTableExportData(table) {
    var headers = [];
    table.querySelectorAll("thead th").forEach(function (th) {
      var labelEl = th.querySelector(".th-text, .th-label");
      headers.push(cleanExportText(labelEl ? labelEl.textContent : th.textContent));
    });

    var rows = [];
    table.querySelectorAll("tbody tr").forEach(function (tr) {
      var cells = tr.querySelectorAll("td");
      // Skip a "No cohorts match..." / "No Domains or Checklist Items
      // selected." placeholder row -- it isn't real data.
      if (tr.querySelector(".empty-state")) return;
      var row = [];
      cells.forEach(function (td) {
        var raw = td.hasAttribute("data-export-value") ? td.getAttribute("data-export-value") : td.textContent;
        row.push(cleanExportText(raw));
      });
      rows.push(row);
    });

    return { headers: headers, rows: rows };
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Deferred, not immediate -- some browsers need the object URL to
    // still be valid a moment after the click before the download
    // actually starts.
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // RFC 4180 field escaping: quote (doubling any inner quotes) whenever a
  // field itself contains a comma, quote, or newline that would otherwise
  // make it ambiguous.
  function csvCell(text) {
    if (/[",\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function exportTableCSV(data, filename) {
    var lines = [data.headers].concat(data.rows).map(function (row) {
      return row.map(csvCell).join(",");
    });
    // A leading UTF-8 BOM so Excel -- which otherwise guesses ANSI and
    // mangles the em dashes and accented characters that show up
    // elsewhere in this dataset -- opens the file with the right
    // encoding instead of needing a manual "Import" step.
    var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, filename + ".csv");
  }

  function exportTableExcel(data, filename) {
    if (typeof XLSX === "undefined") {
      window.alert(
        "The Excel export library failed to load (probably a network issue) -- please reload the page and try again."
      );
      return;
    }
    var sheet = XLSX.utils.aoa_to_sheet([data.headers].concat(data.rows));
    var workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Data");
    XLSX.writeFile(workbook, filename + ".xlsx");
  }

  function exportTablePDF(data, filename, title) {
    if (typeof window.jspdf === "undefined") {
      window.alert(
        "The PDF export library failed to load (probably a network issue) -- please reload the page and try again."
      );
      return;
    }
    // Landscape -- every one of these tables is far wider than it is
    // tall, with anywhere from a handful up to dozens of columns.
    var doc = new window.jspdf.jsPDF({ orientation: "landscape" });
    doc.setFontSize(13);
    doc.text(title, 14, 12);
    doc.autoTable({
      head: [data.headers],
      body: data.rows,
      startY: 17,
      styles: { fontSize: 6.5, cellPadding: 1.5 },
      headStyles: { fillColor: [47, 90, 130] },
      margin: { left: 8, right: 8 },
    });
    doc.save(filename + ".pdf");
  }

  function wireTableExport() {
    document.querySelectorAll(".table-export").forEach(function (control) {
      var tableId = control.getAttribute("data-table");
      var table = document.getElementById(tableId);
      var filename = control.getAttribute("data-filename") || "export";
      var title = TABLE_EXPORT_TITLES[tableId] || filename;
      if (!table) return;
      control.querySelectorAll("[data-export]").forEach(function (btn) {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener("click", function () {
          var data = collectTableExportData(table);
          var kind = btn.getAttribute("data-export");
          if (kind === "csv") exportTableCSV(data, filename);
          else if (kind === "excel") exportTableExcel(data, filename);
          else if (kind === "pdf") exportTablePDF(data, filename, title);
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Landscape-phone / small-tablet width (641px-900px): Coverage Checklist
  // sidebar height sync
  // ---------------------------------------------------------------------
  // At these widths ".two-col" still shows the Cohorts / Procedure
  // Separation Type / Checklist items picker sidebar beside the matrix
  // table (see dashboard.css) rather than stacked above it. The sidebar's
  // own natural stacked height often runs shorter than the table beside
  // it, leaving its column trailing off above the table's actual bottom
  // edge. A pure-CSS attempt at this (`align-items: stretch` on ".two-col"
  // plus `flex: 1 1 0` on the two taller pickers) turned out not to be
  // reliable across browsers -- see the comment above the
  // "min-width: 641px) and (max-width: 900px)" media block in
  // dashboard.css -- so this does the same "grow the two non-fixed
  // pickers to line up with the table's bottom edge" job directly in
  // pixels instead.
  //
  // Like the removed syncChecklistHeight() (see the NOTE further below,
  // near renderTable2Body()), this must NEVER shrink the sidebar/pickers
  // below their own natural content height -- only ever grow the Cohorts
  // and Checklist items pickers to match a *taller* table, never shrink
  // them to match a *shorter* one (e.g. one that's been filtered down to
  // just a couple of rows). The Procedure Separation Type picker in the
  // middle always has exactly five fixed entries, so it's deliberately
  // left out of this -- growing it too would just spread those five
  // entries further apart for no reason.
  function syncLandscapeChecklistHeight() {
    var cohortPicker = document.getElementById("t2-cohort-picker");
    var columnPicker = document.getElementById("t2-column-picker");
    var tableScroll = document.getElementById("t2-table-scroll");
    var sidebar = document.getElementById("t2-sidebar");
    var panel = document.getElementById("panel-checklist");
    if (!cohortPicker || !columnPicker || !tableScroll || !sidebar || !panel) {
      return;
    }

    var inRange = window.innerWidth > 640 && window.innerWidth <= 900;
    if (!panel.classList.contains("active") || !inRange) {
      // Outside this breakpoint (or the tab isn't visible), always fall
      // back to natural, unassigned heights -- e.g. resizing/rotating out
      // of this range after a previous sync assigned explicit pixel
      // heights, or the mobile (<=640px) stacked layout, or desktop.
      cohortPicker.style.height = "";
      columnPicker.style.height = "";
      return;
    }

    // Clear any previously-assigned heights first so the "natural" sizes
    // measured below reflect the pickers' actual current content (e.g.
    // after a filter changes how many cohorts/items are listed), not a
    // stale height left over from an earlier sync.
    cohortPicker.style.height = "";
    columnPicker.style.height = "";

    var naturalSidebarHeight = sidebar.offsetHeight;
    var tableHeight = tableScroll.offsetHeight;
    var extra = tableHeight - naturalSidebarHeight;
    if (extra <= 0) {
      // The table is the shorter (or equal) side -- leave the pickers at
      // their natural height rather than shrinking them to match it.
      return;
    }

    var cohortNatural = cohortPicker.offsetHeight;
    var columnNatural = columnPicker.offsetHeight;
    var addEach = extra / 2;
    cohortPicker.style.height = cohortNatural + addEach + "px";
    columnPicker.style.height = columnNatural + addEach + "px";
  }


  // ---------------------------------------------------------------------
  // Modal (cohort detail)
  // ---------------------------------------------------------------------

  function wireModal() {
    var backdrop = document.getElementById("detail-modal-backdrop");
    if (!backdrop) return;
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) closeModal();
    });
    var closeBtn = backdrop.querySelector(".close-btn");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });
  }

  function closeModal() {
    var backdrop = document.getElementById("detail-modal-backdrop");
    if (backdrop) backdrop.classList.remove("open");
  }

  function openCohortDetail(record) {
    var backdrop = document.getElementById("detail-modal-backdrop");
    var body = document.getElementById("detail-modal-body");
    if (!backdrop || !body || !state.schema) return;

    var nameCol = state.schema.cohort_name_column;
    var html = "";
    html += '<button type="button" class="close-btn" aria-label="Close">\u2715</button>';
    html += "<h2>" + escapeHtml(record[nameCol] || "Cohort") + "</h2>";

    html += renderDetailSection("Overview", state.schema.metadata_columns, record);
    html += renderDetailSection("Classification &amp; Temporal Validity", state.schema.validity_columns, record);
    html += renderDetailSection("Questionnaire Coverage", state.schema.checklist_columns, record);

    body.innerHTML = html;
    var closeBtn = body.querySelector(".close-btn");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    // The Procedure Separation Type row (see renderDetailSection() below)
    // is marked with this class and a `data-proc-type` attribute holding
    // its raw "Type N" value, rather than being colored/tooltipped inline
    // via the HTML string -- attachTooltip() needs a real DOM element to
    // wire event listeners to, which only exists after this innerHTML
    // assignment runs.
    var procDd = body.querySelector(".detail-proc-type");
    if (procDd) {
      var procVal = procDd.getAttribute("data-proc-type") || "";
      var typeDef = procedureTypeDefinition(procVal);
      if (typeDef) {
        // Instant (0ms), matching the cohort name's immediacy elsewhere in
        // the app, rather than the 500ms used for the checklist matrix's
        // value chips -- this is a single, deliberately-clicked-into detail
        // view rather than a table full of cells to skim quickly.
        attachTooltip(procDd, typeDef, 0);
      }
    }
    backdrop.classList.add("open");
  }

  function renderDetailSection(title, columns, record) {
    if (!columns || !columns.length) return "";
    var procCol = state.schema && state.schema.procedure_separation_type_column;
    var html = "<h3>" + title + "</h3><dl>";
    columns.forEach(function (col) {
      var rawVal = record[col];
      // Color-code the Procedure Separation Type value the same way it's
      // colored everywhere else (Cohort Summary/Custom Filter row accents,
      // Coverage Checklist matrix, Map markers) -- see procedureTypeColor()
      // -- and mark it with a class + data attribute so openCohortDetail()
      // above can attach the instant definition tooltip once this HTML is
      // actually in the DOM.
      if (procCol && col === procCol) {
        var typeVal = String(rawVal || "").trim();
        var color = procedureTypeColor(typeVal);
        html +=
          "<dt>" + escapeHtml(t3FieldLabel(col)) + "</dt>" +
          '<dd class="detail-proc-type"' +
          (color ? ' style="color:' + color + '; font-weight:700;"' : "") +
          ' data-proc-type="' + escapeHtml(typeVal) + '">' +
          escapeHtml(DD.formatValue(rawVal)) +
          "</dd>";
      } else {
        html += "<dt>" + escapeHtml(col) + "</dt><dd>" + escapeHtml(DD.formatValue(rawVal)) + "</dd>";
      }
    });
    html += "</dl>";
    return html;
  }

  // ---------------------------------------------------------------------
  // Sortable table headers (shared by Table 1, Table 2, and Table 3)
  // ---------------------------------------------------------------------

  // Every sortable <th> in the Cohort Summary, Coverage Checklist, and
  // Custom Filter tables gets the same click-to-sort behavior, the same
  // ".sortable" hover affordance, and the same sort icon -- two arrows
  // side by side, one pointing up and one pointing down (dim/idle when
  // its column isn't the active sort; whichever arrow matches the active
  // direction lights up once it is -- see
  // ".sort-icon"/".sorted-asc"/".sorted-desc" in dashboard.css). Where
  // that icon sits within the header cell (right-of-label vs.
  // below-label) is decided entirely by CSS based on which column this
  // is, not by anything here. The first click on a column always sorts
  // ascending; clicking that same column again flips to descending;
  // clicking a different column starts over at ascending on the new
  // column.
  function buildSortIcon() {
    var icon = document.createElement("span");
    icon.className = "sort-icon";
    icon.setAttribute("aria-hidden", "true");
    var up = document.createElement("span");
    up.className = "arrow-up";
    up.textContent = "\u2191"; // upward arrow
    var down = document.createElement("span");
    down.className = "arrow-down";
    down.textContent = "\u2193"; // downward arrow
    icon.appendChild(up);
    icon.appendChild(down);
    return icon;
  }

  /**
   * Wires up a <th> as a sortable column header. `sortState` is one of
   * state.t1Sort/t2Sort/t3Sort ({column, direction}); `columnKey` is the
   * record field this particular header should sort by; `onSortChange` is
   * called (with no arguments) to re-render whichever table this header
   * belongs to once the click has updated `sortState`. Doesn't touch
   * `th.title` -- callers set that themselves, since some headers (e.g.
   * the Coverage Checklist's already-truncated item names) need to keep
   * their own tooltip text alongside the "click to sort" hint rather than
   * having it replaced outright.
   */
  function wireSortableHeader(th, columnKey, sortState, onSortChange) {
    th.classList.add("sortable");
    th.appendChild(buildSortIcon());
    th.addEventListener("click", function () {
      if (sortState.column === columnKey) {
        sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
      } else {
        sortState.column = columnKey;
        sortState.direction = "asc";
      }
      onSortChange();
    });
    if (sortState.column === columnKey) {
      th.classList.add(sortState.direction === "asc" ? "sorted-asc" : "sorted-desc");
    }
  }

  // ---------------------------------------------------------------------
  // Table 1: Cohort summary
  // ---------------------------------------------------------------------

  var T1_COLUMNS = null; // resolved once schema is known

  // Fixed-color lookup for a raw Procedure Separation Type cell value (e.g.
  // "Type 3"). Returns null for blank/unrecognized values so callers can
  // decide whether/how to fall back (see accent-row/-cell usage below).
  // Unlike the old DD.paletteFor()-based approach, this is independent of
  // which types happen to be present in whatever subset of cohorts is being
  // rendered, so the same type always gets the same color everywhere it
  // appears (Cohort Summary, Coverage Checklist, Custom Filter, Map).
  function procedureTypeColor(rawVal) {
    var val = rawVal === null || rawVal === undefined ? "" : String(rawVal).trim();
    if (!val) return null;
    return (DD.PROCEDURE_SEPARATION_TYPE_COLORS || {})[val] || null;
  }

  // Optional hand-picked pastel override for a type's "always-on" row
  // background (see DD.PROCEDURE_SEPARATION_TYPE_ROW_TINTS for why only
  // some types need one). Returns null when there's no override, so
  // callers can leave dashboard.css's automatic color-mix() formula in
  // place for those types instead.
  function procedureTypeRowTint(rawVal) {
    var val = rawVal === null || rawVal === undefined ? "" : String(rawVal).trim();
    if (!val) return null;
    return (DD.PROCEDURE_SEPARATION_TYPE_ROW_TINTS || {})[val] || null;
  }

  // Same lookup pattern as procedureTypeColor() above, but returns the
  // fixed definition text (from DD.PROCEDURE_SEPARATION_TYPE_DEFINITIONS --
  // the same list renderProcedureSeparationKey() draws its key/legend text
  // from) for a given raw "Type N" value. Used to power the Coverage
  // Checklist's Procedure separation type cell tooltip below, so hovering
  // a "Type 3" cell shows that type's definition without having to look it
  // up in the key off to the side.
  function procedureTypeDefinition(rawVal) {
    var val = rawVal === null || rawVal === undefined ? "" : String(rawVal).trim();
    if (!val) return null;
    var match = (DD.PROCEDURE_SEPARATION_TYPE_DEFINITIONS || []).filter(function (def) {
      return def.type === val;
    })[0];
    return match ? match.type + ": " + match.text : null;
  }

  function t1Columns() {
    if (T1_COLUMNS) return T1_COLUMNS;
    var procCol = state.schema.procedure_separation_type_column;
    // These six don't correspond to any column fetch_data.py currently
    // pulls from the spreadsheet -- there's no source data for them yet,
    // by design (see the "Reproductive Surgical History" discussion this
    // table was built from). Their `key` intentionally matches no record
    // field, so every cohort's cell renders blank (DD.formatValue(undefined)
    // -- see dashboard-data.js) rather than a misleading "No", until real
    // columns exist to back them.
    var PENDING_NOTE = "Not yet collected in this database";
    // `narrow: true` on every column but Cohort Name -- their labels (e.g.
    // "Distinguishes laterality (unilateral vs. bilateral)?") run much
    // longer than their actual cell content (a short Yes/No/Type N/blank),
    // so renderTable1Head()/renderTable3() wrap these headers instead of
    // forcing the column to fit the whole label on one line -- see
    // ".narrow-col-header" in dashboard.css.
    T1_COLUMNS = [
      { key: state.schema.cohort_name_column, label: "Cohort Name" },
      { key: procCol, label: "Hysterectomy Inference Types", narrow: true },
      { key: "Sample Size (N)", label: "Sample Size (N)", narrow: true },
      { key: "Age Range", label: "Age Range", narrow: true },
      // The raw sheet's sex-composition column is renamed to this stable
      // "% Female" key by fetch_data.py's _rename_sex_composition_column()
      // regardless of how the raw header is currently spelled/punctuated
      // (it's been "%male/%female" and "%female." at different points) --
      // see SEX_COMPOSITION_COLUMN in fetch_data.py.
      { key: "% Female", label: "% Female", narrow: true },
      // Reproductive Surgical History -- the same distinctions behind each
      // cohort's Hysterectomy Inference Types classification, broken out
      // into individual yes/no questions. Only the first two currently
      // have real source data (see PENDING_NOTE above for the rest).
      { key: "Hysterectomy item", label: "Asks about hysterectomy?", narrow: true },
      { key: "Oophorectomy item", label: "Asks about oophorectomy?", narrow: true },
      { key: "Distinguishes laterality (unilateral vs. bilateral)", label: "Distinguishes laterality (unilateral vs. bilateral)?", note: PENDING_NOTE, narrow: true },
      { key: "Distinguishes hysterectomy type (supracervical / total / radical)", label: "Distinguishes hysterectomy type (supracervical / total / radical)?", note: PENDING_NOTE, narrow: true },
      { key: "Age at surgery recorded", label: "Age at surgery recorded?", note: PENDING_NOTE, narrow: true },
      { key: "Indication of surgery recorded", label: "Indication of surgery recorded?", note: PENDING_NOTE, narrow: true },
      { key: "Surgery captured at baseline only or also as incident events", label: "Baseline only or also incident?", note: PENDING_NOTE, narrow: true },
      { key: "Intact uterine / ovarian status used as enrollment eligibility criterion", label: "Used as enrollment eligibility criterion?", note: PENDING_NOTE, narrow: true },
    ];
    return T1_COLUMNS;
  }

  function renderTable1() {
    var searchInput = document.getElementById("t1-search");
    if (searchInput && !searchInput._wired) {
      searchInput.addEventListener("input", renderTable1Body);
      searchInput._wired = true;
    }
    renderTable1Head();
    renderTable1Body();
  }

  function renderTable1Head() {
    var thead = document.querySelector("#t1-table thead tr");
    if (!thead) return;
    // Default to alphabetical-by-cohort-name the first time this table
    // renders, until the user picks a different sort column themselves
    // (see the "Sortable table headers" section above).
    if (!state.t1Sort.column) {
      state.t1Sort.column = state.schema.cohort_name_column;
    }
    thead.innerHTML = "";
    t1Columns().forEach(function (col) {
      appendColumnHeader(thead, col, state.t1Sort, renderTable1Body);
    });
  }

  // Shared by renderTable1Head() and renderTable3() -- both build their
  // <thead> from t1Columns()-shaped {key, label, narrow} objects. A
  // "narrow" column's label wraps (and soft-hyphenates) onto multiple
  // lines, with its sort icon centered underneath, matching the Coverage
  // Checklist's narrow-column treatment (see ".narrow-col-header" in
  // dashboard.css) -- its cell content (a short Yes/No/Type N/blank) is
  // nowhere near as wide as the label describing it, so wrapping the
  // header keeps the column sized to its actual content instead of
  // ballooning out to fit one long unwrapped label. Everything else (just
  // Cohort Name, the one genuinely wide column) keeps the plain one-line,
  // icon-on-the-right treatment.
  function appendColumnHeader(theadRow, col, sortState, onSortChange) {
    var th = document.createElement("th");
    var label = document.createElement("span");
    if (col.narrow) {
      th.classList.add("narrow-col-header");
      label.className = "th-label";
      label.textContent = softHyphenateLabel(col.label);
    } else {
      label.className = "th-text";
      label.textContent = col.label;
    }
    th.appendChild(label);
    th.title = "Click to sort by " + col.label + (col.note ? " (" + col.note + ")" : "");
    wireSortableHeader(th, col.key, sortState, onSortChange);
    theadRow.appendChild(th);
  }

  function renderTable1Body() {
    var tbody = document.querySelector("#t1-table tbody");
    var countEl = document.getElementById("t1-result-count");
    if (!tbody) return;

    var query = (document.getElementById("t1-search") || {}).value || "";
    query = query.trim().toLowerCase();
    var nameCol = state.schema.cohort_name_column;
    var procCol = state.schema.procedure_separation_type_column;

    var rows = state.cohorts.filter(function (r) {
      if (!query) return true;
      return String(r[nameCol] || "").toLowerCase().indexOf(query) !== -1;
    });

    if (state.t1Sort.column) {
      rows = DD.sortRecords(rows, state.t1Sort.column, state.t1Sort.direction);
    }

    // Re-render header to update sort arrows
    renderTable1Head();

    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="' + t1Columns().length + '" class="empty-state">No cohorts match your search.</td></tr>';
    } else {
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        var procVal = procCol ? String(r[procCol] || "").trim() : "";
        var accentColor = procedureTypeColor(procVal);
        // Set the accent color on the <tr> itself (not just a child cell) --
        // CSS custom properties only cascade downward, so a row-level tint
        // rule can't see a value set on one of its own cells. This is what
        // makes the always-on tint and full-row hover highlight below
        // actually work across the whole row, not just the first cell.
        if (accentColor) {
          tr.classList.add("accent-row");
          tr.style.setProperty("--row-accent", accentColor);
          var rowTint = procedureTypeRowTint(procVal);
          if (rowTint) tr.style.setProperty("--row-tint", rowTint);
        }

        var typeTd = null;
        t1Columns().forEach(function (col, i) {
          var td = document.createElement("td");
          td.textContent = DD.formatValue(r[col.key]);
          // The Hysterectomy Inference Types cell itself -- not just this
          // row's background tint above -- gets bolded and colored to
          // match its type, with a hover tooltip giving that type's full
          // definition (see procedureTypeDefinition()), the same treatment
          // this value gets in the cohort detail modal (".detail-proc-
          // type" in renderDetailSection()) -- this table is specifically
          // about that classification, so its own column gets the same
          // at-a-glance color coding here too.
          if (col.key === procCol) {
            if (accentColor) {
              td.style.color = accentColor;
              td.style.fontWeight = "700";
            }
            var typeDef = procedureTypeDefinition(procVal);
            if (typeDef) attachTooltip(td, typeDef, 500);
            typeTd = td;
          }
          if (col.narrow) td.classList.add("narrow-col-cell");
          if (i === 0 && accentColor) {
            td.classList.add("accent-cell");
          }
          tr.appendChild(td);
        });
        tr.style.cursor = "pointer";
        tr.title = "Click for full record";
        // An element's own "title" (even empty) takes precedence over an
        // ancestor's for that element specifically -- so this stops the
        // native "Click for full record" tooltip from covering the type
        // cell, where the custom attachTooltip() above should be the only
        // tooltip a hover shows (the two were overlapping/fighting for the
        // same space). The rest of the row is unaffected, since no other
        // cell sets its own "title".
        if (typeTd) typeTd.title = "";
        tr.addEventListener("click", function () {
          openCohortDetail(r);
        });
        tbody.appendChild(tr);
      });
    }

    if (countEl) {
      countEl.textContent = rows.length + " of " + state.cohorts.length + " cohort(s)";
    }
  }

  // ---------------------------------------------------------------------
  // Table 2: Women's Health Data Inventory matrix
  // ---------------------------------------------------------------------

  var CHECKLIST_CATEGORY_ROLLUPS = null; // memoized -- see checklistCategoryRollups()

  // Computes the matrix's 11 default umbrella-category columns from
  // schema.checklist_groups (see CHECKLIST_SECTION_GROUPS in fetch_data.py)
  // -- one rollup per top-level category, each carrying the flat list of
  // every real checklist_columns entry nested underneath it (a header that
  // is itself also a real column, like "Menopause-related symptom items",
  // counts as one of its own members). These are what the table shows
  // before the user drills into any specific item via the "Checklist
  // items" picker -- see categoryRollupClassification() below for how a
  // rollup's per-cohort value is derived from its members, and
  // renderTable2Body() for where these render alongside picker-selected
  // individual columns.
  function checklistCategoryRollups() {
    if (CHECKLIST_CATEGORY_ROLLUPS) return CHECKLIST_CATEGORY_ROLLUPS;
    var known = {};
    (state.schema.checklist_columns || []).forEach(function (c) {
      known[c] = true;
    });
    function collectMembers(node) {
      var members = known[node.header] ? [node.header] : [];
      (node.children || []).forEach(function (child) {
        if (typeof child === "string") {
          if (known[child]) members.push(child);
        } else {
          members = members.concat(collectMembers(child));
        }
      });
      return members;
    }
    CHECKLIST_CATEGORY_ROLLUPS = (state.schema.checklist_groups || []).map(function (group) {
      return {
        key: " rollup:" + group.header,
        label: group.header,
        members: collectMembers(group),
      };
    });
    return CHECKLIST_CATEGORY_ROLLUPS;
  }

  // A category rollup is deliberately only ever yes/no/empty -- never
  // "partial"/"other" -- per this rule: a domain is "no" or blank ONLY if
  // every one of its member columns, for this cohort, is itself "no" or
  // blank; ANY member that's "yes", "to some extent", or non-blank free
  // text ("other" -- e.g. "Other women's health item"'s actual answer,
  // once it's not empty and doesn't literally read "no") counts as the
  // domain having *something* tracked, so the domain reads "yes". Only
  // once nothing at all is tracked does it fall back to "no" (if at least
  // one member is an explicit "no") or "empty" (if every member is blank).
  // `label` lists which specific member(s) drove a "yes"/"no" result, each
  // with its own raw value, for the cell's tooltip (see
  // renderTable2Body()) -- left "" when every member is blank, so that
  // tooltip's "(no data)" fallback applies.
  function categoryRollupClassification(record, members) {
    var trackedParts = []; // members classified yes/partial/other -- anything non-blank, non-"no"
    var noParts = []; // members explicitly classified "no"
    members.forEach(function (m) {
      var classified = DD.classifyValue(record[m]);
      if (classified.category === "empty") return;
      if (classified.category === "no") {
        noParts.push(m);
      } else {
        trackedParts.push(m + ": " + classified.label);
      }
    });
    if (trackedParts.length) return { category: "yes", label: trackedParts.join("; ") };
    if (noParts.length) return { category: "no", label: noParts.join(", ") };
    return { category: "empty", label: "" };
  }

  // The "Domains" picker and the top-level rows of the "Checklist items"
  // picker both read/write the same state.t2SelectedDomains Set (see
  // renderChecklistItemPicker()'s domainSelectedSet parameter), so a
  // change from either one has to redraw *both* pickers -- not just
  // itself -- to keep their checkboxes in sync, plus the table. Passed as
  // the `onChange` callback to both.
  function renderDomainAndColumnPickers() {
    renderPicker(
      "t2-domain-picker",
      checklistCategoryRollups().map(function (r) {
        return r.label;
      }),
      state.t2SelectedDomains,
      renderDomainAndColumnPickers
    );
    renderChecklistItemPicker(
      "t2-column-picker",
      state.schema.checklist_columns || [],
      state.schema.checklist_groups || [],
      state.t2SelectedColumns,
      state.t2SelectedDomains,
      renderDomainAndColumnPickers
    );
    renderTable2Body();
  }

  function renderTable2() {
    renderPicker(
      "t2-cohort-picker",
      state.cohorts.map(function (c) {
        return c[state.schema.cohort_name_column];
      }),
      state.t2SelectedCohorts,
      renderTable2Body
    );
    renderDomainAndColumnPickers();
    renderCategoryLegend("t2-legend");
    renderTable2Hint();
  }

  function renderTable2Hint() {
    var el = document.getElementById("t2-hint-text");
    if (!el) return;
    var total = checklistCategoryRollups().length;
    el.textContent =
      "The matrix opens showing all " +
      total +
      " domain(s) as a single rollup column each -- \"yes\" as soon as any item in " +
      "that domain is tracked. Uncheck a domain under \"Domains\" (or in \"Checklist Items\", " +
      "which checks/unchecks all of its individual items too) to hide its column, or check " +
      "specific items under \"Checklist Items\" to break a domain out into its individual " +
      "questions as additional columns. Use the Cohorts checkboxes to narrow which cohorts " +
      "are shown. Hover a colored cell to see its exact response text, and click a cohort " +
      "name for its full record.";
  }

  function renderPicker(containerId, allValues, selectedSet, onChange) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var listEl = container.querySelector(".picker-list");
    var searchEl = container.querySelector(".picker-search");
    var selectAllBtn = container.querySelector(".picker-select-all");
    var selectNoneBtn = container.querySelector(".picker-select-none");

    function draw() {
      if (!listEl) return;
      var query = (searchEl && searchEl.value ? searchEl.value : "").trim().toLowerCase();
      listEl.innerHTML = "";
      allValues.forEach(function (val) {
        if (query && String(val).toLowerCase().indexOf(query) === -1) return;
        var label = document.createElement("label");
        label.className = "picker-row";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selectedSet.has(val);
        cb.addEventListener("change", function () {
          if (cb.checked) selectedSet.add(val);
          else selectedSet.delete(val);
          onChange();
        });
        var span = document.createElement("span");
        span.textContent = val;
        label.appendChild(cb);
        label.appendChild(span);
        listEl.appendChild(label);
      });
      if (!listEl.children.length) {
        listEl.innerHTML = '<p class="empty-state">No matches.</p>';
      }
    }

    if (searchEl && !searchEl._wired) {
      searchEl.addEventListener("input", draw);
      searchEl._wired = true;
    }
    if (selectAllBtn && !selectAllBtn._wired) {
      selectAllBtn.addEventListener("click", function () {
        allValues.forEach(function (v) {
          selectedSet.add(v);
        });
        draw();
        onChange();
      });
      selectAllBtn._wired = true;
    }
    if (selectNoneBtn && !selectNoneBtn._wired) {
      selectNoneBtn.addEventListener("click", function () {
        selectedSet.clear();
        draw();
        onChange();
      });
      selectNoneBtn._wired = true;
    }

    draw();
  }

  // A specialized picker for the Coverage Checklist's "Checklist items"
  // sidebar (as opposed to the plain flat renderPicker() above, still used
  // for the Cohorts sidebar). Groups a header column (e.g. "Vasomotor
  // symptom items") together with its known sub-items (e.g. "Hot flashes
  // item", "Night sweats item" -- see CHECKLIST_SECTION_GROUPS in
  // fetch_data.py / schema.checklist_groups) so the header reads visually
  // as a whole section and its checkbox cascades to/from all of its
  // children, while each child can still be checked/unchecked
  // individually. Supports arbitrary nesting depth -- a group's "children"
  // array can itself contain nested {header, children} group objects (e.g.
  // "Menopause-related symptom items" nests "Vasomotor symptom items",
  // which in turn nests "Hot flashes item"/"Night sweats item") -- not
  // just leaf column-name strings.
  // `domainSelectedSet` (state.t2SelectedDomains) is the *same* Set the
  // "Domains" picker (see renderTable2()) reads and writes -- a top-level
  // group's row here is one of the 11 domains, so its checkbox reflects
  // and controls domain rollup-column visibility directly, kept in sync
  // with the Domains picker's own checkbox for that same domain, rather
  // than the usual tri-state "are all of this header's real descendant
  // columns individually selected" cascade every *nested* header below it
  // still uses (see makeRow()/groupState() below).
  function renderChecklistItemPicker(containerId, allValues, groups, selectedSet, domainSelectedSet, onChange) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var listEl = container.querySelector(".picker-list");
    var searchEl = container.querySelector(".picker-search");
    var selectAllBtn = container.querySelector(".picker-select-all");
    var selectNoneBtn = container.querySelector(".picker-select-none");

    // A group's header does NOT have to be a real checklist_columns entry
    // -- purely organizational/umbrella headers (e.g. "Menopause", which
    // has no per-cohort Yes/No data of its own, just three real subgroups
    // nested under it) are supported too. A group is only dropped if NONE
    // of its (possibly nested) descendants made it into this dataset's
    // checklist_columns (e.g. the small mock dataset doesn't have most of
    // these real columns, so schema.checklist_groups ends up empty for it
    // -- see build_schema() in fetch_data.py). Recursive since a "child"
    // can be another group object instead of a leaf string.
    var allSet = {};
    allValues.forEach(function (v) {
      allSet[v] = true;
    });

    function filterGroup(g) {
      var filteredChildren = [];
      (g.children || []).forEach(function (child) {
        if (typeof child === "string") {
          if (allSet[child]) filteredChildren.push(child);
        } else {
          var filteredChild = filterGroup(child);
          if (filteredChild) filteredChildren.push(filteredChild);
        }
      });
      if (!filteredChildren.length) return null;
      return { header: g.header, children: filteredChildren };
    }

    // Every REAL (checklist_columns-backed) header or leaf value that
    // appears anywhere in a filtered group's subtree, gathered
    // recursively -- used for the tri-state checked/indeterminate
    // calculation on a header's own checkbox (`groupState`/
    // `setGroupSelected`) and to know which top-level values are
    // "consumed" by a group (and so shouldn't also be drawn as a
    // standalone flat row in `draw()` below). A purely organizational
    // header (not itself a real column -- see filterGroup() above) is
    // deliberately NOT included here: it has no per-cohort data of its
    // own to select/deselect or count toward "all"/"some"/"none", it's
    // just a collapsible label wrapping its real descendants.
    function collectMembers(node) {
      var members = allSet[node.header] ? [node.header] : [];
      (node.children || []).forEach(function (child) {
        if (typeof child === "string") {
          members.push(child);
        } else {
          members = members.concat(collectMembers(child));
        }
      });
      return members;
    }

    function matchesQuery(value, query) {
      return String(value).toLowerCase().indexOf(query) !== -1;
    }

    // True if `node`'s own header matches the query, or any descendant
    // (leaf or nested header, at any depth) does.
    function nodeMatches(node, query) {
      if (!query) return true;
      if (matchesQuery(node.header, query)) return true;
      return (node.children || []).some(function (child) {
        return typeof child === "string" ? matchesQuery(child, query) : nodeMatches(child, query);
      });
    }

    // Kept as an array (not just a header-keyed map) so top-level groups
    // -- including purely organizational headers with no real column of
    // their own, which would never be visited by an allValues.forEach()
    // pass -- render in the order schema.checklist_groups defines, not in
    // dataset-column order. See draw() below.
    var topLevelOrder = [];
    var consumedSet = {};
    (groups || []).forEach(function (g) {
      var filtered = filterGroup(g);
      if (!filtered) return;
      topLevelOrder.push(filtered);
      collectMembers(filtered).forEach(function (m) {
        if (m !== filtered.header) consumedSet[m] = true;
      });
    });

    function groupState(node) {
      var members = collectMembers(node);
      var selectedCount = members.filter(function (m) {
        return selectedSet.has(m);
      }).length;
      if (selectedCount === 0) return "none";
      if (selectedCount === members.length) return "all";
      return "some";
    }

    function setGroupSelected(node, selected) {
      collectMembers(node).forEach(function (m) {
        if (selected) selectedSet.add(m);
        else selectedSet.delete(m);
      });
    }

    // `valueOrNode` is a leaf column-name string, unless opts.isHeader is
    // true, in which case it's a (possibly nested) group node object.
    function makeRow(valueOrNode, opts) {
      opts = opts || {};
      var label = document.createElement("label");
      var depthClass = opts.depth ? " picker-depth-" + opts.depth : "";
      label.className = "picker-row" + (opts.extraClass ? " " + opts.extraClass : "") + depthClass;
      var cb = document.createElement("input");
      cb.type = "checkbox";
      var displayText;

      if (opts.isHeader && opts.isTopLevel) {
        // One of the 11 domains -- see the comment on
        // renderChecklistItemPicker()'s domainSelectedSet parameter above.
        // Plain boolean (never indeterminate): this checkbox's own
        // checked/unchecked state *is* the domain's rollup-column
        // visibility, not a summary of its children's individual
        // selection state. Toggling it ALSO cascades to every one of the
        // domain's individual items (setGroupSelected(), the same
        // cascade a nested sub-header's own checkbox uses below) as a
        // convenience -- checking a domain both shows its rollup *and*
        // breaks it out into every one of its specific columns in one
        // click, rather than needing two separate clicks to get both.
        var domainNode = valueOrNode;
        displayText = domainNode.header;
        cb.checked = domainSelectedSet.has(domainNode.header);
        cb.addEventListener("change", function () {
          if (cb.checked) domainSelectedSet.add(domainNode.header);
          else domainSelectedSet.delete(domainNode.header);
          setGroupSelected(domainNode, cb.checked);
          draw();
          onChange();
        });
      } else if (opts.isHeader) {
        var node = valueOrNode;
        displayText = node.header;
        var st = groupState(node);
        cb.checked = st === "all";
        cb.indeterminate = st === "some";
        cb.addEventListener("change", function () {
          // A native checkbox click always flips `checked` from whatever
          // it was immediately before (true/false; indeterminate has no
          // effect on that flip) -- so this naturally lands on "select
          // every member" from either "none" or "some", and "deselect
          // every member" from "all", which is exactly the tri-state
          // cascade behavior wanted here (cascading through every level
          // of nesting, via collectMembers()).
          setGroupSelected(node, cb.checked);
          draw();
          onChange();
        });
      } else {
        displayText = valueOrNode;
        cb.checked = selectedSet.has(valueOrNode);
        cb.addEventListener("change", function () {
          if (cb.checked) selectedSet.add(valueOrNode);
          else selectedSet.delete(valueOrNode);
          // Redraw so a child toggle updates its ancestor header(s)'
          // checked/indeterminate state too.
          draw();
          onChange();
        });
      }

      var span = document.createElement("span");
      span.textContent = displayText;
      label.appendChild(cb);
      label.appendChild(span);
      return label;
    }

    // Recursively renders `node` (a header row) at the given indentation
    // `depth`, followed by its children (leaf rows at depth + 1, or
    // further-nested header rows rendered via a recursive call at
    // depth + 1). Respects the search `query`: if the node's own header
    // matches, every descendant renders unfiltered; otherwise only
    // descendants that themselves match (leaf text match, or a nested
    // node with any matching descendant) are shown. Returns false (and
    // renders nothing) if neither the header nor any descendant matches
    // a non-empty query.
    function renderNode(node, depth, query) {
      var headerMatches = !query || matchesQuery(node.header, query);
      var childrenToRender = (node.children || []).filter(function (child) {
        if (headerMatches) return true;
        return typeof child === "string" ? matchesQuery(child, query) : nodeMatches(child, query);
      });
      if (query && !headerMatches && !childrenToRender.length) return false;

      listEl.appendChild(
        makeRow(node, { isHeader: true, isTopLevel: depth === 0, extraClass: "picker-header", depth: depth })
      );
      childrenToRender.forEach(function (child) {
        if (typeof child === "string") {
          listEl.appendChild(makeRow(child, { extraClass: "picker-child", depth: depth + 1 }));
        } else {
          renderNode(child, depth + 1, headerMatches ? "" : query);
        }
      });
      return true;
    }

    function draw() {
      if (!listEl) return;
      var query = (searchEl && searchEl.value ? searchEl.value : "").trim().toLowerCase();
      listEl.innerHTML = "";
      var renderedAny = false;

      // Top-level groups render first, in the order schema.checklist_groups
      // defines (together with each one's full, possibly multi-level
      // subtree) via renderNode() below. This has to happen before the
      // allValues pass -- not driven by it -- because a purely
      // organizational header (e.g. "Menopause") isn't itself a real
      // checklist_columns entry and so would never be visited by an
      // allValues.forEach() pass at all.
      var renderedTopHeaders = {};
      topLevelOrder.forEach(function (node) {
        if (renderNode(node, 0, query)) renderedAny = true;
        renderedTopHeaders[node.header] = true;
      });

      allValues.forEach(function (val) {
        // Already rendered above, as a top-level group header.
        if (renderedTopHeaders[val]) return;
        // Anything else that's a member of some group's subtree (a leaf
        // item or a nested sub-header) was already rendered alongside its
        // top-level ancestor above, so skip it here.
        if (consumedSet[val]) return;

        if (query && !matchesQuery(val, query)) return;
        listEl.appendChild(makeRow(val, { depth: 0 }));
        renderedAny = true;
      });

      if (!renderedAny) {
        listEl.innerHTML = '<p class="empty-state">No matches.</p>';
      }
    }

    if (searchEl && !searchEl._wired) {
      searchEl.addEventListener("input", draw);
      searchEl._wired = true;
    }
    if (selectAllBtn && !selectAllBtn._wired) {
      selectAllBtn.addEventListener("click", function () {
        allValues.forEach(function (v) {
          selectedSet.add(v);
        });
        draw();
        onChange();
      });
      selectAllBtn._wired = true;
    }
    if (selectNoneBtn && !selectNoneBtn._wired) {
      selectNoneBtn.addEventListener("click", function () {
        selectedSet.clear();
        draw();
        onChange();
      });
      selectNoneBtn._wired = true;
    }

    draw();
  }

  // NOTE: this used to be syncChecklistHeight() -- it forced the picker
  // sidebar's rendered height (in pixels, via JS) to match the Coverage
  // Checklist table's own rendered height, so a naturally-tall sidebar
  // wouldn't leave dead space below the table's last row. That had an
  // unwanted side effect: whenever filtering shrank the table down to just
  // a row or two (or a "No cohorts selected" message), the sidebar's
  // checkbox lists got forced down to that same tiny height too, clipping
  // most of the pickers. `.two-col` (see dashboard.css) already uses
  // `align-items: start`, which means the grid was never actually
  // stretching one column to match the other in the first place -- the JS
  // height-forcing was the only thing coupling them, in *either*
  // direction. Removing it lets each side simply size to its own natural
  // content: the table shows exactly its own rows (no forced tall/short
  // box), and the sidebar always shows its own full picker stack (with its
  // own internal scrolling -- see "#t2-sidebar" and ".picker" in
  // dashboard.css) regardless of how many rows the table happens to be
  // showing at the moment.

  // Renders the fixed Procedure Separation Type definitions (see
  // DD.PROCEDURE_SEPARATION_TYPE_DEFINITIONS), each paired with its fixed
  // color swatch (DD.PROCEDURE_SEPARATION_TYPE_COLORS) -- this is the
  // *only* legend for Procedure Separation Type color-coding anywhere on
  // the site (there's no separate flat swatch-only legend elsewhere), so a
  // viewer can see both what a color means and what a type actually is in
  // one place. Static/data-independent (every type is always listed,
  // regardless of which types are actually present among the currently
  // visible cohorts), so it's safe to call unconditionally, once, for every
  // panel's key container -- see renderAllProcedureSeparationKeys() below.
  function renderProcedureSeparationKey(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;
    // A title naming which specific visual cue this key explains -- "row
    // color" for the two data tables (Hysterectomy Inference Classification,
    // Custom Filter), "marker color" for the Map -- rather than the old
    // combined "(row / marker color)" wording everywhere, since only one of
    // the two is ever actually true for any given container. On the static
    // Information tab there's no row or marker to refer to at all, and the
    // surrounding paragraph ("The exact types are as follows:") already
    // introduces the list, so the title is omitted there entirely.
    var titleSuffix =
      containerId === "info-procedure-key"
        ? null
        : containerId === "map-procedure-key"
        ? "marker color"
        : "row color";
    var html =
      (titleSuffix
        ? '<p class="procedure-key-title">Hysterectomy Inference Types<br />(' + titleSuffix + ")</p>"
        : "") + '<div class="procedure-key-list">';
    (DD.PROCEDURE_SEPARATION_TYPE_DEFINITIONS || []).forEach(function (def) {
      var color = (DD.PROCEDURE_SEPARATION_TYPE_COLORS || {})[def.type] || "#999";
      html +=
        '<div class="procedure-key-item">' +
        '<span class="procedure-key-swatch" style="background:' + color + '"></span>' +
        "<div>" +
        '<span class="procedure-key-type">' + escapeHtml(def.type) + "</span>" +
        '<p class="procedure-key-text">' + escapeHtml(def.text) + "</p>" +
        "</div>" +
        "</div>";
    });
    html += "</div>";
    el.innerHTML = html;
  }

  // The key's content is identical everywhere it appears -- called once per
  // container, for Hysterectomy Inference Classification, Custom Filter,
  // and Map's key sidebars plus the embedded copy on the Information tab,
  // right after the static DOM is in place (see DOMContentLoaded below).
  // Doesn't depend on state.cohorts/state.schema at all, so it doesn't
  // need to wait for loadData()'s fetch to resolve. Women's Health Data
  // Inventory (formerly Coverage Checklist) used to have its own copy of
  // this key too, but no longer does -- see its section in index.html.
  function renderAllProcedureSeparationKeys() {
    ["info-procedure-key", "t1-procedure-key", "t3-procedure-key", "map-procedure-key"].forEach(
      renderProcedureSeparationKey
    );
  }

  function renderCategoryLegend(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var items = [
      ["yes", "Yes"],
      ["no", "No"],
      ["partial", "To some extent"],
      ["empty", "No data"],
      ["other", "Other / free text"],
    ];
    el.innerHTML = items
      .map(function (pair) {
        return (
          '<span class="legend-item"><span class="swatch" style="background:' +
          DD.CATEGORY_COLORS[pair[0]] +
          '"></span>' +
          escapeHtml(pair[1]) +
          "</span>"
        );
      })
      .join("");
  }

  function renderTable2Body() {
    var table = document.getElementById("t2-table");
    var countEl = document.getElementById("t2-result-count");
    if (!table) return;

    var nameCol = state.schema.cohort_name_column;
    // Default to alphabetical-by-cohort-name the first time this table
    // renders, until the user picks a different sort column themselves
    // (see the "Sortable table headers" section above t1Columns()).
    if (!state.t2Sort.column) {
      state.t2Sort.column = nameCol;
    }
    // The 11 umbrella-category rollups render for whichever domains are
    // checked in the "Domains" picker (state.t2SelectedDomains, all 11 by
    // default -- see loadData()); "columns" here is just whichever
    // specific leaf items the user has additionally drilled into via the
    // "Checklist items" picker, rendered after them.
    var rollups = checklistCategoryRollups().filter(function (r) {
      return state.t2SelectedDomains.has(r.label);
    });
    var columns = (state.schema.checklist_columns || []).filter(function (c) {
      return state.t2SelectedColumns.has(c);
    });
    var rows = state.cohorts.filter(function (r) {
      return state.t2SelectedCohorts.has(r[nameCol]);
    });
    rows = DD.sortRecords(rows, state.t2Sort.column, state.t2Sort.direction);

    var thead = table.querySelector("thead");
    var tbody = table.querySelector("tbody");
    thead.innerHTML = "";
    tbody.innerHTML = "";

    var headRow = document.createElement("tr");
    var cornerTh = document.createElement("th");
    cornerTh.className = "cohort-col-header";
    // Wrapped in a span, same as every other sortable header -- see the
    // comment in renderTable1Head() -- so the right-edge sort icon (this
    // column is wide/horizontal like the other data-tables, not narrow
    // like the checklist columns below, so it gets that same right-side
    // placement rather than the bottom-of-cell one) never overlaps it.
    var cornerLabel = document.createElement("span");
    cornerLabel.className = "th-text";
    cornerLabel.textContent = "Cohort";
    cornerTh.appendChild(cornerLabel);
    cornerTh.title = "Click to sort by Cohort";
    wireSortableHeader(cornerTh, nameCol, state.t2Sort, renderTable2Body);
    headRow.appendChild(cornerTh);

    // Rollup columns aren't sortable -- there's no real record field behind
    // a rollup's synthetic key for DD.sortRecords() to read (see
    // categoryRollupClassification()), and a "which domain has more yeses"
    // ordering isn't a meaningful question the way sorting a real column
    // is -- so these headers skip wireSortableHeader() entirely (no sort
    // icon, no click handler).
    rollups.forEach(function (rollup) {
      var th = document.createElement("th");
      th.className = "rollup-col-header";
      var label = document.createElement("span");
      label.className = "th-label";
      label.textContent = softHyphenateLabel(rollup.label);
      th.appendChild(label);
      th.title = rollup.label + " \u2014 \"yes\" if any item in this domain is tracked";
      headRow.appendChild(th);
    });

    columns.forEach(function (col) {
      var th = document.createElement("th");
      // The label text lives in its own inner span rather than directly on
      // the <th> -- see the ".th-label" rule in dashboard.css.
      var label = document.createElement("span");
      label.className = "th-label";
      // Soft-hyphenated version of the column name -- see
      // softHyphenateLabel() above -- so a long word wrapping onto a
      // second line inside this narrow column shows a visible hyphen at
      // the break instead of silently splitting mid-word. A soft hyphen
      // (U+00AD) is a real character, not markup, so this is still safe
      // to set via textContent.
      label.textContent = softHyphenateLabel(col);
      th.appendChild(label);
      // Keep the full (non-hyphenated) column name as the native tooltip
      // -- it's still useful on its own for a hyphenated/wrapped label --
      // and add the "click to sort" hint alongside it rather than
      // replacing it outright.
      th.title = col + " \u2014 click to sort";
      wireSortableHeader(th, col, state.t2Sort, renderTable2Body);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    if (!rows.length || (!rollups.length && !columns.length)) {
      var msg = !rows.length ? "No cohorts selected." : "No Domains or Checklist Items selected.";
      tbody.innerHTML = '<tr><td class="empty-state">' + msg + "</td></tr>";
    } else {
      rows.forEach(function (r) {
        var tr = document.createElement("tr");

        var nameTd = document.createElement("td");
        nameTd.className = "cohort-cell";
        nameTd.textContent = r[nameCol];
        // This column is width-capped with ellipsis truncation (see
        // ".cohort-cell" in dashboard.css) so long names can get cut off
        // visually. A plain `title` attribute would work but native
        // tooltips have a built-in browser delay (~1-1.5s) -- too slow
        // when the whole point is reading the truncated name right away --
        // so use the custom, instant (0ms) tooltip helper instead.
        attachTooltip(
          nameTd,
          function () {
            return (r[nameCol] || "") + " \u2014 click for full record";
          },
          0
        );
        nameTd.addEventListener("click", function () {
          openCohortDetail(r);
        });
        tr.appendChild(nameTd);

        rollups.forEach(function (rollup) {
          var td = document.createElement("td");
          var classified = categoryRollupClassification(r, rollup.members);
          var chip = document.createElement("span");
          chip.className = "chip cat-" + classified.category;
          attachTooltip(
            chip,
            rollup.label + ": " + (classified.label || "(no data)"),
            500
          );
          chip.textContent = chipSymbol(classified.category, classified.label);
          // The cell's visible glyph (Y/N/~/T) is too compact to be useful
          // in an exported file -- see collectTableExportData() -- so
          // exports read this attribute instead and get the same full
          // text the chip's own tooltip above already shows.
          td.setAttribute("data-export-value", classified.label || "");
          td.appendChild(chip);
          tr.appendChild(td);
        });

        columns.forEach(function (col) {
          var td = document.createElement("td");
          var classified = DD.classifyValue(r[col]);
          var chip = document.createElement("span");
          chip.className = "chip cat-" + classified.category;
          // A shorter (500ms), but still not-instant, custom tooltip --
          // see attachTooltip() above -- so quickly passing the mouse
          // across a row of chips doesn't spam a tooltip for every cell,
          // while still being noticeably faster than the native `title`
          // default. Only the cohort name cell (see above) is instant.
          attachTooltip(chip, col + ": " + (classified.label || "(no data)"), 500);
          chip.textContent = chipSymbol(classified.category, classified.label);
          td.setAttribute("data-export-value", classified.label || "");
          td.appendChild(chip);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    if (countEl) {
      countEl.textContent =
        rows.length +
        " cohort(s) \u00d7 " +
        rollups.length +
        " domain(s)" +
        (columns.length ? " + " + columns.length + " specific item(s)" : "");
    }

    // A filter/search change can shrink or grow the table's own rendered
    // height (fewer/more matching rows), so the landscape-breakpoint
    // sidebar height sync (see syncLandscapeChecklistHeight() above) needs
    // to re-run here too, not just on tab-switch/resize. No-ops instantly
    // outside the 641-900px range or while this tab isn't visible.
    syncLandscapeChecklistHeight();
  }

  function chipSymbol(category, label) {
    switch (category) {
      case "yes":
        return "Y";
      case "no":
        return "N";
      case "partial":
        return "~";
      case "empty":
        return "";
      default:
        // "other" (free text) -- a fixed "T" (for "text") icon, matching
        // the solid-square + single-white-glyph look of Y/N/~, rather than
        // trying to cram the actual (often long) free-text value into the
        // chip itself. The full value is still available via this chip's
        // tooltip (see attachTooltip() call above).
        return "T";
    }
  }

  // ---------------------------------------------------------------------
  // Table 3: AND/OR filter builder
  // ---------------------------------------------------------------------

  function t3AllFields() {
    var s = state.schema;
    var procCol = s.procedure_separation_type_column;
    var metadata = s.metadata_columns || [];
    var validity = s.validity_columns || [];

    // Procedure Separation Type is one of the more commonly-used filter
    // conditions, but structurally it's just another entry inside
    // validity_columns (see fetch_data.py), so left alone it lands wherever
    // it happens to sort among the other validity/metadata columns --
    // usually buried mid-list. Pull it out and pin it as the second option,
    // right after Cohort Name specifically -- NOT after the rest of
    // metadata_columns (there are 8 of those: Cohort Name, Country, Public
    // Availability, N, Age Range, ..., so appending after the *whole* array
    // used to bury it at position 9 instead of 2, which is what this
    // rewrite fixes) -- then let the rest of metadata, followed by the rest
    // of validity_columns, follow in their original order minus this one
    // entry.
    var restMetadata = metadata.filter(function (c) {
      return c !== procCol && c !== metadata[0];
    });
    var restValidity = validity.filter(function (c) {
      return c !== procCol;
    });

    var fields = [];
    if (metadata.length) {
      fields.push(metadata[0]); // Cohort Name
    }
    if (procCol && fields.indexOf(procCol) === -1) {
      fields.push(procCol);
    }
    return fields
      .concat(restMetadata)
      .concat(restValidity)
      .concat(s.checklist_columns || []);
  }

  // The Procedure Separation Type column's actual header in the source
  // spreadsheet is "Classification Validity - Procedure Separation Type"
  // (see schema.json's procedure_separation_type_column) -- every lookup
  // against the data (state.schema, DD.uniqueValues(), evaluateGroup()
  // filtering, etc.) has to keep using that exact string as-is, but
  // showing the whole thing as a dropdown option reads as confusing/
  // redundant. Table 1's column definitions already shorten it the same
  // way for its header (see the "Procedure Separation Type" label in
  // t1Columns() above) -- this mirrors that here for the Custom Filter
  // field dropdown specifically. Every other field's raw column name is
  // left untouched.
  function t3FieldLabel(field) {
    var procCol = state.schema && state.schema.procedure_separation_type_column;
    if (procCol && field === procCol) {
      return "Hysterectomy Inference Types";
    }
    return field;
  }

  // ---------------------------------------------------------------------
  // Custom Filter: shareable link
  // ---------------------------------------------------------------------
  // The whole filter setup (mode + every condition's field/operator/value)
  // round-trips through a single "?filter=" query parameter, a JSON blob
  // percent-encoded via encodeURIComponent() -- no server, no shortener,
  // just enough to reconstruct state.t3Conditions/state.t3Mode from a
  // pasted URL. Condition "id"s are deliberately left out of the encoded
  // payload (they're only ever used locally, as React-key-style DOM
  // identity for the condition-row list -- see renderTable3Conditions()
  // -- meaningless to whoever opens the link) and get fresh ones assigned
  // on decode instead.
  var SHARE_FILTER_PARAM = "filter";

  function buildShareableFilterURL() {
    var payload = {
      mode: state.t3Mode,
      conditions: state.t3Conditions.map(function (c) {
        return { field: c.field, operator: c.operator, value: c.value };
      }),
    };
    var url = new URL(window.location.href);
    url.searchParams.set(SHARE_FILTER_PARAM, JSON.stringify(payload));
    url.hash = "";
    return url.toString();
  }

  // Reads "?filter=" off the current page URL (if present) and returns a
  // {mode, conditions} object ready to assign into state, or null if
  // there's no (valid) shared filter to load. Deliberately tolerant of a
  // malformed/hand-edited value -- falls back to null (the normal "start
  // with one blank condition" behavior in renderTable3Fields() below)
  // rather than throwing and breaking the rest of the page.
  function parseSharedFilterFromURL() {
    var raw;
    try {
      raw = new URLSearchParams(window.location.search).get(SHARE_FILTER_PARAM);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    var payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!payload || !Array.isArray(payload.conditions)) return null;
    var conditions = payload.conditions
      .filter(function (c) {
        return c && typeof c.field === "string" && typeof c.operator === "string";
      })
      .map(function (c) {
        return {
          id: state.t3ConditionIdSeq++,
          field: c.field,
          operator: c.operator,
          value: typeof c.value === "string" ? c.value : "",
        };
      });
    if (!conditions.length) return null;
    return { mode: payload.mode === "any" ? "any" : "all", conditions: conditions };
  }

  function wireTable3Share() {
    var btn = document.getElementById("t3-share");
    var feedback = document.getElementById("t3-share-feedback");
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", function () {
      var url = buildShareableFilterURL();
      var showFeedback = function () {
        if (!feedback) return;
        feedback.hidden = false;
        clearTimeout(feedback._hideTimer);
        feedback._hideTimer = setTimeout(function () {
          feedback.hidden = true;
        }, 2500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(showFeedback, function () {
          window.prompt("Copy this link to share your filter:", url);
        });
      } else {
        // Older browsers without the async Clipboard API -- a visible
        // prompt (its text pre-selected) is the simplest universal
        // fallback that still lets a user copy the link in one action
        // (Ctrl/Cmd+C), without pulling in a polyfill for this one case.
        window.prompt("Copy this link to share your filter:", url);
      }
    });
  }

  function renderTable3Fields() {
    var addBtn = document.getElementById("t3-add-condition");
    var modeSelect = document.getElementById("t3-mode");
    wireTable3Share();
    if (addBtn && !addBtn._wired) {
      addBtn.addEventListener("click", function () {
        var fields = t3AllFields();
        state.t3Conditions.push({
          id: state.t3ConditionIdSeq++,
          field: fields[0] || "",
          operator: "equals",
          value: "",
        });
        renderTable3Conditions();
        renderTable3();
      });
      addBtn._wired = true;
    }
    if (modeSelect && !modeSelect._wired) {
      modeSelect.addEventListener("change", function () {
        state.t3Mode = modeSelect.value === "any" ? "any" : "all";
        renderTable3();
      });
      modeSelect._wired = true;
    }
    // Start with one condition row so the UI isn't empty.
    if (state.t3Conditions.length === 0) {
      state.t3Conditions.push({
        id: state.t3ConditionIdSeq++,
        field: t3AllFields()[0] || "",
        operator: "equals",
        value: "",
      });
    }
    renderTable3Conditions();
  }

  function renderTable3Conditions() {
    var container = document.getElementById("t3-conditions");
    if (!container) return;
    var fields = t3AllFields();

    container.innerHTML = "";
    state.t3Conditions.forEach(function (cond) {
      var row = document.createElement("div");
      row.className = "filter-row";

      var fieldSelect = document.createElement("select");
      fields.forEach(function (f) {
        var opt = document.createElement("option");
        opt.value = f;
        opt.textContent = t3FieldLabel(f);
        if (f === cond.field) opt.selected = true;
        fieldSelect.appendChild(opt);
      });
      fieldSelect.addEventListener("change", function () {
        cond.field = fieldSelect.value;
        refreshDatalist();
        renderTable3();
      });

      var opSelect = document.createElement("select");
      DD.OPERATORS.forEach(function (op) {
        var opt = document.createElement("option");
        opt.value = op;
        opt.textContent = operatorLabel(op);
        if (op === cond.operator) opt.selected = true;
        opSelect.appendChild(opt);
      });
      opSelect.addEventListener("change", function () {
        cond.operator = opSelect.value;
        valueInput.style.display = op_needsValue(cond.operator) ? "" : "none";
        renderTable3();
      });

      var valueInput = document.createElement("input");
      valueInput.type = "text";
      valueInput.placeholder = "value";
      valueInput.title =
        "Start typing to see existing values for this field. Close " +
        "matches (different spacing/punctuation, minor typos, numbers " +
        "inside a range) are still found even if you don't pick one.";
      valueInput.setAttribute("autocomplete", "off");
      valueInput.value = cond.value;
      valueInput.style.display = op_needsValue(cond.operator) ? "" : "none";
      valueInput.addEventListener("input", function () {
        cond.value = valueInput.value;
        renderTable3();
      });

      // Native <datalist> autocomplete: shows the actual values present in
      // the currently-selected field as a dropdown while typing, so you
      // can see what's available instead of having to guess exact
      // spelling/formatting. Kept in sync whenever the field changes.
      var datalist = document.createElement("datalist");
      var datalistId = "t3-options-" + cond.id;
      datalist.id = datalistId;
      valueInput.setAttribute("list", datalistId);

      function refreshDatalist() {
        datalist.innerHTML = "";
        if (!cond.field) return;
        DD.uniqueValues(state.cohorts, cond.field).forEach(function (val) {
          var opt = document.createElement("option");
          opt.value = val;
          datalist.appendChild(opt);
        });
      }
      refreshDatalist();

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-condition";
      removeBtn.title = "Remove condition";
      removeBtn.textContent = "\u2715";
      removeBtn.addEventListener("click", function () {
        state.t3Conditions = state.t3Conditions.filter(function (c) {
          return c.id !== cond.id;
        });
        renderTable3Conditions();
        renderTable3();
      });

      row.appendChild(fieldSelect);
      row.appendChild(opSelect);
      row.appendChild(valueInput);
      row.appendChild(datalist);
      row.appendChild(removeBtn);
      container.appendChild(row);
    });
  }

  function op_needsValue(op) {
    return op !== "is_empty" && op !== "is_not_empty";
  }

  function operatorLabel(op) {
    var labels = {
      equals: "equals",
      not_equals: "does not equal",
      contains: "contains",
      not_contains: "does not contain",
      greater_than: "is greater than",
      less_than: "is less than",
      is_empty: "is empty",
      is_not_empty: "is not empty",
    };
    return labels[op] || op;
  }

  function renderTable3() {
    var table = document.getElementById("t3-table");
    var countEl = document.getElementById("t3-result-count");
    if (!table) return;

    // A condition only actually filters anything once it's "complete": it
    // has a field, and if its operator needs a value (most do -- is_empty /
    // is_not_empty don't), that value has been entered. Otherwise an
    // unfinished row (e.g. the default blank condition on first load) would
    // make every cohort look like a non-match, which is confusing.
    var activeConditions = state.t3Conditions
      .filter(function (c) {
        if (!c.field) return false;
        if (op_needsValue(c.operator) && (!c.value || !c.value.trim())) return false;
        return true;
      })
      .map(function (c) {
        // "equals"/"not_equals" only get DD._matchesEquals()'s tolerant
        // typo/formatting fallback when the value wasn't picked verbatim
        // from this field's own list of real existing values (its value
        // input's <datalist> -- see renderTable3Conditions()) -- an exact
        // value should match that value alone, not anything merely close
        // to it (e.g. one cohort name shouldn't match a *different*
        // cohort's name just because most of the string happens to be the
        // same). A plain object copy (not mutating `c`/state.t3Conditions
        // itself) since this flag is only meaningful for this one
        // evaluation pass.
        if (c.operator !== "equals" && c.operator !== "not_equals") return c;
        var exact = DD.uniqueValues(state.cohorts, c.field).some(function (v) {
          return v.toLowerCase() === c.value.trim().toLowerCase();
        });
        if (!exact) return c;
        return { id: c.id, field: c.field, operator: c.operator, value: c.value, exactValue: true };
      });

    var rows = state.cohorts.filter(function (r) {
      return DD.evaluateGroup(r, activeConditions, state.t3Mode);
    });
    // Default to alphabetical-by-cohort-name the first time this table
    // renders, until the user picks a different sort column themselves
    // (see the "Sortable table headers" section above t1Columns()).
    if (!state.t3Sort.column) {
      state.t3Sort.column = state.schema.cohort_name_column;
    }
    rows = DD.sortRecords(rows, state.t3Sort.column, state.t3Sort.direction);

    // Baseline summary columns (always shown, in this fixed order) --
    // deliberately just these four, not every column t1Columns() now
    // carries for Hysterectomy Inference Classification (the Reproductive
    // Surgical History breakdown belongs to that tab specifically, not
    // here) -- and, unlike before, not Hysterectomy Inference Types either:
    // that classification's row color-coding/bolding/key is only relevant
    // once the user actually asks about it, so it (like every other field)
    // only appears -- as one of extraColumns below -- once it's an active
    // condition's field, in the order that condition was added.
    var procCol = state.schema.procedure_separation_type_column;
    var BASE_KEYS = [state.schema.cohort_name_column, "Sample Size (N)", "Age Range", "% Female"];
    var baseColumns = t1Columns().filter(function (c) {
      return BASE_KEYS.indexOf(c.key) !== -1;
    });
    var baseKeySet = {};
    baseColumns.forEach(function (c) {
      baseKeySet[c.key] = true;
    });
    var extraColumns = [];
    var seenExtra = {};
    activeConditions.forEach(function (c) {
      if (baseKeySet[c.field] || seenExtra[c.field]) return;
      seenExtra[c.field] = true;
      // narrow: true -- same reasoning as t1Columns()'s narrow columns
      // (see appendColumnHeader()): a filter condition's field is
      // typically a checklist item, whose label is a full question much
      // longer than its own Yes/No/Partial/blank cell content.
      extraColumns.push({ key: c.field, label: t3FieldLabel(c.field), narrow: true });
    });
    var columns = baseColumns.concat(extraColumns);
    // Whether Hysterectomy Inference Types is currently one of those extra
    // columns -- gates the row color-coding/bolding below and the compact
    // type legend (see refreshTypeLegend()) the same way.
    var typeColActive = !!procCol && seenExtra[procCol];
    refreshTypeLegend(typeColActive);

    var thead = table.querySelector("thead tr");
    var tbody = table.querySelector("tbody");
    thead.innerHTML = "";
    tbody.innerHTML = "";

    columns.forEach(function (col) {
      appendColumnHeader(thead, col, state.t3Sort, renderTable3);
    });

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="' + columns.length + '" class="empty-state">No cohorts match these conditions.</td></tr>';
    } else {
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        var procVal = typeColActive ? String(r[procCol] || "").trim() : "";
        var accentColor = typeColActive ? procedureTypeColor(procVal) : null;
        // Same row-level accent pattern as Table 1/Table 2 -- see the
        // comment in renderTable1Body() for why this is set on the <tr>
        // itself. Only applied at all once Hysterectomy Inference Types is
        // an active condition field (typeColActive above) -- otherwise
        // this table has no classification of its own to color-code by.
        if (accentColor) {
          tr.classList.add("accent-row");
          tr.style.setProperty("--row-accent", accentColor);
          var rowTint = procedureTypeRowTint(procVal);
          if (rowTint) tr.style.setProperty("--row-tint", rowTint);
        }
        var typeTd = null;
        columns.forEach(function (col, i) {
          var td = document.createElement("td");
          td.textContent = DD.formatValue(r[col.key]);
          // Same bold/colored/hover-definition treatment as Hysterectomy
          // Inference Classification's own Type column -- see the
          // matching comment in renderTable1Body().
          if (typeColActive && col.key === procCol) {
            if (accentColor) {
              td.style.color = accentColor;
              td.style.fontWeight = "700";
            }
            var typeDef = procedureTypeDefinition(procVal);
            if (typeDef) attachTooltip(td, typeDef, 500);
            typeTd = td;
          }
          if (col.narrow) td.classList.add("narrow-col-cell");
          if (i === 0 && accentColor) {
            td.classList.add("accent-cell");
          }
          tr.appendChild(td);
        });
        tr.style.cursor = "pointer";
        tr.title = "Click for full record";
        // See the matching comment in renderTable1Body() -- stops that
        // title from fighting with the type cell's own tooltip above.
        if (typeTd) typeTd.title = "";
        tr.addEventListener("click", function () {
          openCohortDetail(r);
        });
        tbody.appendChild(tr);
      });
    }

    if (countEl) {
      countEl.textContent = rows.length + " of " + state.cohorts.length + " cohort(s) match";
    }
  }

  // Compact swatch-only legend for Hysterectomy Inference Types on Custom
  // Filter -- shown only while that field is an active condition (see
  // typeColActive in renderTable3() above), unlike the full key aside
  // every other tab gets: this table's whole point is building custom
  // conditions, so a tall always-on definitions sidebar would compete for
  // space with that far more often than it'd actually be relevant. Reuses
  // ".legend" (see renderCategoryLegend()) rather than inventing a second
  // legend style for the same shape of content.
  function refreshTypeLegend(active) {
    var el = document.getElementById("t3-type-legend");
    if (!el) return;
    el.hidden = !active;
    if (!active) {
      // Also clear out any stale content from the last time this was
      // active, rather than just leaving it hidden -- belt-and-suspenders
      // alongside the CSS fix (see ".legend[hidden]") for the same bug:
      // ".legend"'s own `display: flex` otherwise wins over the plain
      // `hidden` attribute's default `display: none` (author styles beat
      // the UA stylesheet regardless of specificity), which was letting
      // this reappear, still showing its last content, the moment
      // anything gave it height again.
      el.innerHTML = "";
      return;
    }
    el.innerHTML = "";

    var caption = document.createElement("span");
    caption.className = "legend-caption";
    caption.textContent = "Hysterectomy Inference Types:";
    el.appendChild(caption);

    (DD.PROCEDURE_SEPARATION_TYPE_DEFINITIONS || []).forEach(function (def) {
      var color = (DD.PROCEDURE_SEPARATION_TYPE_COLORS || {})[def.type] || "#999";
      var item = document.createElement("span");
      item.className = "legend-item";
      var swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = color;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(def.type));
      // Same definition text procedureTypeDefinition() gives the table
      // cells themselves (see renderTable3()) -- so the key on its own is
      // just as informative as hovering a matching row, not just a color
      // reference.
      attachTooltip(item, def.type + ": " + def.text, 300);
      el.appendChild(item);
    });

    var note = document.createElement("span");
    note.className = "legend-note";
    note.textContent = "Hover over each type for that type's definition.";
    el.appendChild(note);
  }

  // ---------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------

  // The zoom level DD.markerRadius()'s pixel sizes are calibrated for (must
  // match the initial map.setView() zoom below) -- markers grow/shrink
  // relative to this as the user zooms, via DD.zoomRadiusScale().
  var MAP_REFERENCE_ZOOM = 2;

  /** A cohort's on-screen marker radius (px) at the map's current zoom. */
  function markerRadiusForZoom(baseRadius) {
    var zoom = state.map ? state.map.getZoom() : MAP_REFERENCE_ZOOM;
    return baseRadius * DD.zoomRadiusScale(zoom, MAP_REFERENCE_ZOOM);
  }

  function initMap() {
    if (state.mapInitialized) return;

    if (typeof L === "undefined") {
      var panel = document.getElementById("panel-map");
      if (panel) {
        panel.innerHTML =
          '<p class="empty-state">The map library failed to load from its CDN, so the map ' +
          "can't be displayed right now. This is usually temporary (network hiccup or an " +
          "ad/script blocker) -- try reloading the page. If it keeps happening, check your " +
          "browser's console for a blocked-resource error.</p>";
      }
      return;
    }

    state.mapInitialized = true;

    var map = L.map("map", { worldCopyJump: true }).setView([15, 10], 2);
    // Esri's "World Street Map" basemap labels places in English worldwide
    // (Esri's own cartographic reference data, curated in English by
    // default) -- unlike CARTO's "Voyager" tiles (used here previously),
    // which are built on OpenStreetMap's community-contributed place names
    // and label many countries/continents/oceans in their local
    // language/script (e.g. "AMÉRICA", "ÁFRICA/افريقيا", "OCEANIA") rather
    // than English, especially at low (world-view) zoom levels. No API key
    // required. Note the {z}/{y}/{x} tile coordinate order below -- Esri's
    // REST tile service uses this order, the reverse of the {z}/{x}/{y}
    // convention most other XYZ tile providers (including CARTO) use.
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 18,
        attribution:
          "Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, " +
          "METI, Esri China (Hong Kong), Esri (Thailand), TomTom, MapmyIndia, &copy; OpenStreetMap contributors, " +
          "and the GIS User Community",
      }
    ).addTo(map);

    state.map = map;
    // Re-space overlapping markers every time the zoom level changes -- see
    // repositionJitteredMarkers() for why this has to be recomputed per
    // zoom rather than baked in once.
    map.on("zoomend", repositionJitteredMarkers);
    renderMapMarkers();
    setTimeout(function () {
      map.invalidateSize();
    }, 0);
  }

  function renderMapMarkers() {
    if (!state.map) return;
    var procCol = state.schema.procedure_separation_type_column;
    var nameCol = state.schema.cohort_name_column;
    var locationCol = state.schema.resolved_location_column;

    var geocoded = state.cohorts.filter(function (r) {
      return typeof r.Latitude === "number" && typeof r.Longitude === "number";
    });

    if (state.mapLayer) {
      state.map.removeLayer(state.mapLayer);
    }
    var layer = L.layerGroup();

    // Cohorts geocoded to the same country share the exact same centroid
    // coordinate (see fetch_data.py). Group them here so
    // repositionJitteredMarkers() can spread each group apart in
    // screen-pixel space, sized to fit however many cohorts and however
    // large their markers are.
    var groups = new Map();
    geocoded.forEach(function (r) {
      var key = r.Latitude.toFixed(4) + "," + r.Longitude.toFixed(4);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    var markerGroups = [];

    groups.forEach(function (rowsInGroup) {
      // Deterministic order so the ring layout doesn't shuffle between
      // reloads/re-renders.
      rowsInGroup.sort(function (a, b) {
        return String(a[nameCol] || "").localeCompare(String(b[nameCol] || ""));
      });

      var centroid = L.latLng(rowsInGroup[0].Latitude, rowsInGroup[0].Longitude);
      var groupEntries = [];

      rowsInGroup.forEach(function (r, i) {
        var typeVal = r[procCol] ? String(r[procCol]).trim() : "";
        var color = procedureTypeColor(typeVal) || "#666";
        // Radius at the map's current zoom, derived from the cohort's
        // Sample Size (N) -- baseRadius itself never changes, but the
        // on-screen size does as the user zooms (see
        // markerRadiusForZoom()/DD.zoomRadiusScale()), so it's recomputed
        // from this on every zoomend via repositionJitteredMarkers()
        // rather than baked into a fixed style.
        var baseRadius = DD.markerRadius(r["Sample Size (N)"]);
        var marker = L.circleMarker(centroid, {
          radius: markerRadiusForZoom(baseRadius),
          color: color,
          fillColor: color,
          fillOpacity: 0.65,
          weight: 1.5,
        });

        var tooltipHtml =
          '<div class="cohort-tooltip"><strong>' +
          escapeHtml(r[nameCol] || "") +
          "</strong><br/>" +
          // Listed as its own labeled line alongside the other variables
          // below (rather than right next to the cohort name) to match how
          // Procedure Separation Type is presented everywhere else (see
          // t1Columns() above and the Cohort Summary table it drives). The
          // "Type N" value itself (not the "Procedure Separation Type: "
          // label) is colored with this cohort's own `color` (the same one
          // used for the marker/swatch, from procedureTypeColor() above),
          // matching how the Cohort Summary/Coverage Checklist tables color
          // that same value.
          (typeVal
            ? "Hysterectomy Inference Types: " +
              '<span style="color:' + color + '; font-weight:700;">' +
              escapeHtml(typeVal) +
              "</span><br/>"
            : "") +
          "Mapped to: " +
          escapeHtml(DD.formatValue(r[locationCol])) +
          "<br/>" +
          "Sample Size (N): " +
          escapeHtml(DD.formatValue(r["Sample Size (N)"])) +
          "<br/>" +
          "Age range: " +
          escapeHtml(DD.formatValue(r["Age Range"])) +
          "<br/>" +
          "% Female: " +
          escapeHtml(DD.formatValue(r["% Female"])) +
          '<span class="tooltip-hint">Click marker for full details</span>' +
          "</div>";
        marker.bindTooltip(tooltipHtml);

        // Highlight on hover (in addition to the tooltip Leaflet already
        // shows) so it's visually obvious which cohort you're pointing at,
        // especially when markers are close together. Radius is
        // recomputed from the current zoom on every hover (rather than
        // reusing a fixed value from when the marker was created) since
        // the map may have been zoomed since then.
        marker.on("mouseover", function () {
          marker.setStyle({
            radius: markerRadiusForZoom(baseRadius) + 3,
            fillOpacity: 0.9,
            weight: 3,
          });
          marker.bringToFront();
        });
        marker.on("mouseout", function () {
          marker.setStyle({
            radius: markerRadiusForZoom(baseRadius),
            fillOpacity: 0.65,
            weight: 1.5,
          });
        });
        marker.on("click", function () {
          openCohortDetail(r);
        });

        layer.addLayer(marker);
        groupEntries.push({
          marker: marker,
          baseRadius: baseRadius,
          angle: rowsInGroup.length > 1 ? (2 * Math.PI * i) / rowsInGroup.length : 0,
        });
      });

      markerGroups.push({ centroid: centroid, entries: groupEntries });
    });

    layer.addTo(state.map);
    state.mapLayer = layer;
    state.mapMarkerGroups = markerGroups;
    repositionJitteredMarkers();

    var missing = state.cohorts.length - geocoded.length;
    var noteEl = document.getElementById("map-note");
    if (noteEl) {
      noteEl.textContent = missing > 0 ? missing + " cohort(s) omitted (no geocodable location)." : "";
    }
  }

  // Cap on how far (in real-world degrees of latitude) a marker may ever be
  // pushed from its group's true geocoded centroid, no matter how tightly
  // packed the group's screen-pixel "don't touch" spacing would otherwise
  // push it. ~1.5 degrees is roughly 165km -- small relative to a country,
  // but big enough to give real separation once zoomed in to state level.
  // See repositionJitteredMarkers() for why this cap exists.
  var MAX_MARKER_OFFSET_DEG = 1.5;

  /**
   * Spreads apart markers that share an identical geocoded centroid (e.g.
   * several cohorts resolved to the same state or country) around a small
   * ring, computed in *screen-pixel* space at the map's current zoom level
   * rather than as a fixed lat/lon offset -- a fixed degrees-based offset
   * looks fine at one zoom level but collapses back into an overlapping
   * blob at any other, since degrees-per-pixel shrinks a lot as you zoom
   * out. Re-run on every zoom change (wired up in initMap()) so the
   * on-screen spacing stays roughly constant no matter how far in or out
   * you are.
   *
   * A pure pixel-space ring has its own problem, though: at a very zoomed
   * out view, degrees-per-pixel is *huge*, so even a modest, comfortable
   * pixel gap corresponds to a real-world offset of hundreds of km --
   * enough to visibly displace a marker into the ocean or a neighboring
   * state/country at the map's default zoom level. MAX_MARKER_OFFSET_DEG
   * bounds the ring radius to a fixed real-world distance from the true
   * centroid to prevent that: at low zoom this cap wins (so markers stay
   * near their true location, overlapping some if the group is large --
   * which is fine, and only gets more pronounced the further out you zoom),
   * and once zoomed in enough that the cap's pixel equivalent exceeds the
   * "don't touch" spacing, the "don't touch" spacing takes over and markers
   * fan out cleanly with no overlap.
   *
   * Also resizes every marker to match the new zoom level (see
   * markerRadiusForZoom()) before computing ring spacing, so dots grow
   * when you zoom in and shrink when you zoom out -- while every marker is
   * scaled by the same factor, relative sizing between cohorts (by N)
   * stays intact -- and the ring spacing itself reflects each marker's
   * up-to-date on-screen size rather than its size at the previous zoom.
   */
  function repositionJitteredMarkers() {
    if (!state.map || !state.mapMarkerGroups) return;
    var zoom = state.map.getZoom();

    state.mapMarkerGroups.forEach(function (group) {
      group.entries.forEach(function (entry) {
        entry.marker.setRadius(markerRadiusForZoom(entry.baseRadius));
      });

      var k = group.entries.length;
      if (k <= 1) {
        if (k === 1) group.entries[0].marker.setLatLng(group.centroid);
        return;
      }

      var maxRadius = Math.max.apply(
        null,
        group.entries.map(function (e) {
          return markerRadiusForZoom(e.baseRadius);
        })
      );
      // Ring radius large enough that adjacent markers (spaced angleStep
      // apart around the circle) don't touch, given their own size, with a
      // floor so even 2-marker groups get comfortable separation.
      var angleStep = (2 * Math.PI) / k;
      var minSin = Math.max(Math.sin(angleStep / 2), 0.05);
      var desiredGapPx = 6;
      var noTouchRadiusPx = Math.max(
        maxRadius + 14,
        (2 * maxRadius + desiredGapPx) / (2 * minSin)
      );

      var centerPoint = state.map.project(group.centroid, zoom);

      // Real-world-distance cap, converted to this zoom's pixel space (via
      // Leaflet's own projection, so it's exact regardless of latitude).
      var capPoint = state.map.project(
        L.latLng(group.centroid.lat + MAX_MARKER_OFFSET_DEG, group.centroid.lng),
        zoom
      );
      var maxOffsetPx = Math.abs(capPoint.y - centerPoint.y);

      // Aim for the "don't touch" spacing, but never exceed the real-world
      // cap; if the cap is tighter than half a marker's radius (only
      // possible when very zoomed out), fall back to the cap itself rather
      // than forcing extra separation that would blow past it.
      var ringRadiusPx = Math.max(
        Math.min(noTouchRadiusPx, maxOffsetPx),
        Math.min(maxRadius * 0.5, maxOffsetPx)
      );

      group.entries.forEach(function (entry) {
        var offsetPoint = L.point(
          centerPoint.x + ringRadiusPx * Math.cos(entry.angle),
          centerPoint.y + ringRadiusPx * Math.sin(entry.angle)
        );
        entry.marker.setLatLng(state.map.unproject(offsetPoint, zoom));
      });
    });
  }


  // ---------------------------------------------------------------------
  // Custom hover tooltips
  // ---------------------------------------------------------------------

  // The native `title` attribute's tooltip has a fixed, browser-controlled
  // show delay (roughly 1-1.5s in most browsers) that can't be shortened
  // from CSS/JS. Some tooltips on this page need to behave differently:
  // the Coverage Checklist's (ellipsis-truncated) cohort names should pop
  // up the instant the mouse arrives, since the whole point is reading the
  // full name right away, while its checklist-item chips should still
  // wait a beat (500ms) so quickly passing the mouse across a row of chips
  // doesn't spam a tooltip for every cell -- just faster than the sluggish
  // native default. One floating element + helper implements both;
  // wherever it's used it fully replaces `title` (never set both, or
  // they'd double up).
  var _tooltipEl = null;
  function getTooltipEl() {
    if (!_tooltipEl) {
      _tooltipEl = document.createElement("div");
      _tooltipEl.className = "custom-tooltip";
      document.body.appendChild(_tooltipEl);
    }
    return _tooltipEl;
  }
  function positionTooltip(e) {
    var tip = getTooltipEl();
    tip.style.left = e.clientX + 14 + "px";
    tip.style.top = e.clientY + 18 + "px";
  }
  function attachTooltip(el, getText, delayMs) {
    var timer = null;
    function show(e) {
      var text = typeof getText === "function" ? getText() : getText;
      if (!text) return;
      var tip = getTooltipEl();
      tip.textContent = text;
      positionTooltip(e);
      tip.classList.add("visible");
    }
    el.addEventListener("mouseenter", function (e) {
      if (delayMs > 0) {
        timer = window.setTimeout(function () {
          show(e);
        }, delayMs);
      } else {
        show(e);
      }
    });
    el.addEventListener("mousemove", function (e) {
      var tip = getTooltipEl();
      if (tip.classList.contains("visible")) {
        positionTooltip(e);
      }
    });
    el.addEventListener("mouseleave", function () {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      getTooltipEl().classList.remove("visible");
    });
  }

  // ---------------------------------------------------------------------
  // Manual word-break hints (checklist matrix column headers)
  // ---------------------------------------------------------------------

  // CSS `hyphens: auto` (dictionary-based automatic hyphenation) turned out
  // not to reliably show a visible "-" at the break in practice -- long
  // words (e.g. "Hysterectomy") were still wrapping mid-word with no hyphen
  // at all, likely due to a known browser quirk where `overflow-wrap:
  // break-word` (needed as a fallback for any word that still doesn't fit)
  // takes over before the hyphenation dictionary gets a chance to run.
  // Rather than depend on that, insert actual soft hyphens (U+00AD) into
  // long words ourselves -- a soft hyphen is invisible unless the browser
  // actually breaks the line at that exact point, in which case it renders
  // as a normal hyphen. This is a much older and more universally-honored
  // mechanism than the CSS `hyphens` property, so it doesn't depend on
  // dictionary support or interact with `overflow-wrap` the same way.
  // `.th-label` in dashboard.css uses `hyphens: manual` (the CSS default)
  // so the browser limits itself to these explicit break points rather
  // than trying to find additional ones on its own.
  var SOFT_HYPHEN = "\u00AD";

  // Recognizable medical/English suffixes get a break inserted right
  // before them, e.g. "Hyster" + SOFT_HYPHEN + "ectomy" -- a more natural-
  // looking break than an arbitrary mid-word cut. Checked longest-first so
  // "ectomy" doesn't accidentally match inside a word before a longer,
  // more specific suffix does.
  var HYPHENATION_SUFFIXES = [
    "ectomy",
    "ology",
    "ography",
    "itis",
    "osis",
    "ation",
    "ility",
    "tion",
    "ment",
    "ness",
    "ing",
  ];

  // Inserts SOFT_HYPHEN at reasonable break points inside a single long
  // word. Short words are left untouched -- there's no need to hyphenate
  // something that already fits on one line inside an 8em column.
  function softHyphenateWord(word) {
    if (word.length <= 8) return word;
    var lower = word.toLowerCase();
    for (var i = 0; i < HYPHENATION_SUFFIXES.length; i++) {
      var suffix = HYPHENATION_SUFFIXES[i];
      if (lower.length - suffix.length >= 3 && lower.slice(-suffix.length) === suffix) {
        var stem = word.slice(0, word.length - suffix.length);
        return softHyphenateWord(stem) + SOFT_HYPHEN + word.slice(word.length - suffix.length);
      }
    }
    // Fallback for long words with no recognized suffix: break into ~6-
    // character chunks so nothing is left long enough to force an
    // unindicated overflow-wrap break.
    if (word.length <= 10) return word;
    return word.slice(0, 6) + SOFT_HYPHEN + softHyphenateWord(word.slice(6));
  }

  // Applies softHyphenateWord() to every word in a label, leaving spacing
  // and punctuation between words untouched.
  function softHyphenateLabel(label) {
    return String(label || "")
      .split(" ")
      .map(softHyphenateWord)
      .join(" ");
  }

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
