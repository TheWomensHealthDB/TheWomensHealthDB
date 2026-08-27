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
    // Table 2
    t2SelectedCohorts: null, // Set, populated once data loads
    t2SelectedColumns: null, // Set
    t2SelectedTypes: null, // Set of selected "Type N" values (Procedure Separation Type filter)
    t2ShowTypeColumn: true, // "Hide the 'Procedure separation type' column" checkbox in the Procedure Separation Type picker
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
    wireModal();
    renderAllProcedureSeparationKeys();
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
        state.t2SelectedColumns = new Set(state.schema.checklist_columns || []);
        state.t2SelectedTypes = new Set(
          DD.uniqueValues(state.cohorts, state.schema.procedure_separation_type_column)
        );

        renderDataSourceBanner();
        renderTable1();
        renderTable3Fields();

        // Table 2 (Coverage Checklist) and Table 3 (Custom Filter) both
        // build tables with `position: sticky` header cells (see
        // dashboard.css). Building sticky-positioned cells while their tab
        // panel is still `display: none` (every tab except the default
        // "Cohort Summary" one) leaves the browser's sticky-offset
        // calculations stale -- the header ends up rendered behind the
        // body and only self-corrects for a flash on hover, never staying
        // fixed. So, same as the Map tab's initMap() below, defer actually
        // building these two tables' DOM until their tab is first shown
        // (see wireTabs()), and only build eagerly here if that tab
        // happens to already be the active one on load.
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
        document.querySelectorAll(".tab-panel").forEach(function (panel) {
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

        buttons.forEach(function (b) {
          b.classList.toggle("active", b === btn);
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
        // comment in loadData() for why Table 2/3 can't be safely built
        // while their panel is still display:none.
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
        // the Coverage Checklist tab becomes visible, not just the first
        // time it's rendered -- its measurements are all 0 while the panel
        // is display:none, so switching *back* to an already-rendered
        // checklist tab needs its own fresh measurement too. Deferred with
        // the same 0ms setTimeout as the Map's invalidateSize() above, so
        // the panel's just-applied "active" class has actually taken
        // effect (and the panel is laid out/visible) before measuring it.
        if (target === "checklist") {
          setTimeout(syncLandscapeChecklistHeight, 0);
        }
      });
    });

    // Re-run on resize/orientationchange too -- rotating a phone or
    // resizing a browser window can cross in or out of the 641-900px
    // range this applies to, or change the table's rendered height while
    // already inside it. Debounced so a drag-resize doesn't thrash layout
    // on every intermediate pixel.
    var landscapeSyncTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(landscapeSyncTimer);
      landscapeSyncTimer = setTimeout(syncLandscapeChecklistHeight, 120);
    });
    window.addEventListener("orientationchange", function () {
      setTimeout(syncLandscapeChecklistHeight, 150);
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
    T1_COLUMNS = [
      { key: state.schema.cohort_name_column, label: "Cohort Name" },
      { key: procCol, label: "Procedure Separation Type" },
      { key: "Sample Size (N)", label: "Sample Size (N)" },
      { key: "Age Range", label: "Age Range" },
      // The raw sheet's sex-composition column is renamed to this stable
      // "% Female" key by fetch_data.py's _rename_sex_composition_column()
      // regardless of how the raw header is currently spelled/punctuated
      // (it's been "%male/%female" and "%female." at different points) --
      // see SEX_COMPOSITION_COLUMN in fetch_data.py.
      { key: "% Female", label: "% Female" },
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
      var th = document.createElement("th");
      // Label text lives in its own span (rather than directly as the
      // <th>'s text) so the sort icon -- absolutely positioned at the
      // header's right edge, see ".sort-icon" in dashboard.css -- never
      // overlaps or gets visually tangled up with it.
      var label = document.createElement("span");
      label.className = "th-text";
      label.textContent = col.label;
      th.appendChild(label);
      th.title = "Click to sort by " + col.label;
      wireSortableHeader(th, col.key, state.t1Sort, renderTable1Body);
      thead.appendChild(th);
    });
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

        t1Columns().forEach(function (col, i) {
          var td = document.createElement("td");
          td.textContent = DD.formatValue(r[col.key]);
          if (i === 0 && accentColor) {
            td.classList.add("accent-cell");
          }
          tr.appendChild(td);
        });
        tr.style.cursor = "pointer";
        tr.title = "Click for full record";
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
  // Table 2: Coverage checklist matrix
  // ---------------------------------------------------------------------

  function renderTable2() {
    renderPicker(
      "t2-cohort-picker",
      state.cohorts.map(function (c) {
        return c[state.schema.cohort_name_column];
      }),
      state.t2SelectedCohorts,
      renderTable2Body
    );
    renderChecklistItemPicker(
      "t2-column-picker",
      state.schema.checklist_columns || [],
      state.schema.checklist_groups || [],
      state.t2SelectedColumns,
      renderTable2Body
    );
    // Procedure Separation Type isn't a per-cohort yes/no checklist item, so
    // it doesn't belong in the checkbox-toggle "Checklist items" picker
    // above -- instead it gets its own multi-select filter (reusing the
    // plain renderPicker(), same as the Cohorts picker) that narrows which
    // cohort *rows* are shown, plus its own dedicated matrix column (see
    // renderTable2Body()).
    renderPicker(
      "t2-type-picker",
      DD.uniqueValues(state.cohorts, state.schema.procedure_separation_type_column),
      state.t2SelectedTypes,
      renderTable2Body
    );
    wireTypeColumnToggle();
    renderCategoryLegend("t2-legend");
    renderTable2Hint();
    renderTable2Body();
  }

  // Wires the Procedure Separation Type picker's "Hide the 'Procedure
  // separation type' column" checkbox to state.t2ShowTypeColumn --
  // independent of (and not affected by) that same picker's Select
  // all/Select none row-filtering checkboxes just below it. Only toggles
  // whether renderTable2Body() draws the dedicated Procedure Separation
  // Type column; it never changes which cohort rows are shown.
  function wireTypeColumnToggle() {
    var checkbox = document.getElementById("t2-type-hide-column");
    if (!checkbox) return;
    checkbox.checked = !state.t2ShowTypeColumn;
    if (!checkbox._wired) {
      checkbox.addEventListener("change", function () {
        state.t2ShowTypeColumn = !checkbox.checked;
        renderTable2Body();
      });
      checkbox._wired = true;
    }
  }

  function renderTable2Hint() {
    var el = document.getElementById("t2-hint-text");
    if (!el) return;
    var total = (state.schema.checklist_columns || []).length;
    el.textContent =
      "This matrix covers " +
      total +
      " questionnaire item(s) across all cohorts. Use the checkboxes on the menu in the " +
      "left-hand side of the page to narrow which cohorts and items are shown, including " +
      "the Procedure Separation Type filter (select one or more types). Hover a " +
      "colored cell to see its exact response text, and click a cohort name for its full " +
      "record.";
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
  function renderChecklistItemPicker(containerId, allValues, groups, selectedSet, onChange) {
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

      if (opts.isHeader) {
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

      listEl.appendChild(makeRow(node, { isHeader: true, extraClass: "picker-header", depth: depth }));
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
    var html =
      '<p class="procedure-key-title">Procedure Separation Type<br />(row / marker color)</p>' +
      '<div class="procedure-key-list">';
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
  // container, for all four tabs' key sidebars, right after the static DOM
  // is in place (see DOMContentLoaded below). Doesn't depend on
  // state.cohorts/state.schema at all, so it doesn't need to wait for
  // loadData()'s fetch to resolve.
  function renderAllProcedureSeparationKeys() {
    ["t1-procedure-key", "t2-procedure-key", "t3-procedure-key", "map-procedure-key"].forEach(
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
    var procCol = state.schema.procedure_separation_type_column;
    // Default to alphabetical-by-cohort-name the first time this table
    // renders, until the user picks a different sort column themselves
    // (see the "Sortable table headers" section above t1Columns()).
    if (!state.t2Sort.column) {
      state.t2Sort.column = nameCol;
    }
    var columns = (state.schema.checklist_columns || []).filter(function (c) {
      return state.t2SelectedColumns.has(c);
    });
    var rows = state.cohorts.filter(function (r) {
      if (!state.t2SelectedCohorts.has(r[nameCol])) return false;
      // Procedure Separation Type filtering: a cohort with no recognizable
      // type value isn't represented by any checkbox in the type picker
      // (see DD.uniqueValues() in renderTable2()), so it can never be
      // deliberately excluded by the user -- always show it rather than
      // silently hiding it because its blank value can't match anything in
      // t2SelectedTypes.
      var procVal = procCol ? String(r[procCol] || "").trim() : "";
      return procVal === "" || state.t2SelectedTypes.has(procVal);
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

    // Procedure Separation Type gets its own dedicated column (showing
    // "Type N" text, not a Yes/No/Partial-classified chip like the
    // checklist items below), since it isn't a per-cohort yes/no item.
    // Uses the same ".th-label" wrapper as the checklist item headers
    // (rather than ".th-text" like the wider Cohort column above) so it
    // gets that same narrow-column treatment: label on top, sort icon
    // centered underneath it, consistent with every column beside it.
    //
    // The "Hide the 'Procedure separation type' column" checkbox in the
    // Procedure Separation Type picker (see wireTypeColumnToggle()) skips
    // this column entirely -- independent of state.t2SelectedTypes above,
    // which only ever filters which cohort *rows* are shown, never the
    // column itself.
    if (state.t2ShowTypeColumn) {
      var typeTh = document.createElement("th");
      typeTh.className = "type-col-header";
      var typeLabel = document.createElement("span");
      typeLabel.className = "th-label";
      typeLabel.textContent = "Procedure separation type";
      typeTh.appendChild(typeLabel);
      typeTh.title = "Click to sort by Procedure separation type";
      wireSortableHeader(typeTh, procCol, state.t2Sort, renderTable2Body);
      headRow.appendChild(typeTh);
    }

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

    if (!rows.length || !columns.length) {
      var msg = !rows.length ? "No cohorts selected." : "No checklist columns selected.";
      tbody.innerHTML = '<tr><td class="empty-state">' + msg + "</td></tr>";
    } else {
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        var procVal = procCol ? String(r[procCol] || "").trim() : "";
        var accentColor = procedureTypeColor(procVal);
        // Same row-level accent pattern as Table 1 -- see the comment in
        // renderTable1Body() for why this is set on the <tr> itself.
        if (accentColor) {
          tr.classList.add("accent-row");
          tr.style.setProperty("--row-accent", accentColor);
          var rowTint = procedureTypeRowTint(procVal);
          if (rowTint) tr.style.setProperty("--row-tint", rowTint);
        }

        var nameTd = document.createElement("td");
        nameTd.className = "cohort-cell" + (accentColor ? " accent-cell" : "");
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

        if (state.t2ShowTypeColumn) {
          var typeTd = document.createElement("td");
          typeTd.className = "type-cell";
          // The text lives in its own inner span (like the checklist item
          // chips' own element) rather than directly on the <td>, so the
          // hover "enlarge" transform below can be scoped to just the text
          // -- see ".type-cell .type-text:hover" in dashboard.css --
          // instead of transforming (and potentially overlapping
          // neighboring cells with) the whole table cell.
          var typeText = document.createElement("span");
          typeText.className = "type-text";
          typeText.textContent = procVal || "\u2014";
          typeTd.appendChild(typeText);
          if (accentColor) {
            typeTd.style.color = accentColor;
          }
          // Custom tooltip (see attachTooltip() above) showing this type's
          // full definition -- the same text shown in the key/legend off to
          // the side (renderProcedureSeparationKey()) -- so hovering "Type
          // 3" here explains what that means without having to look it up
          // elsewhere. A short (500ms) delay, same as the value chips
          // below, rather than instant like the cohort name -- only the
          // cohort name (which is truncated and needs immediate
          // confirmation of what it says) gets the 0ms treatment.
          var typeDef = procedureTypeDefinition(procVal);
          if (typeDef) {
            attachTooltip(typeTd, typeDef, 500);
          }
          tr.appendChild(typeTd);
        }

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
          td.appendChild(chip);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    if (countEl) {
      countEl.textContent = rows.length + " cohort(s) \u00d7 " + columns.length + " item(s)";
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
      return "Procedure Separation Type";
    }
    return field;
  }

  function renderTable3Fields() {
    var addBtn = document.getElementById("t3-add-condition");
    var modeSelect = document.getElementById("t3-mode");
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
    var activeConditions = state.t3Conditions.filter(function (c) {
      if (!c.field) return false;
      if (op_needsValue(c.operator) && (!c.value || !c.value.trim())) return false;
      return true;
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

    var thead = table.querySelector("thead tr");
    var tbody = table.querySelector("tbody");
    thead.innerHTML = "";
    tbody.innerHTML = "";

    t1Columns().forEach(function (col) {
      var th = document.createElement("th");
      // See the matching comment in renderTable1Head() -- same reasoning
      // for keeping the label text in its own span here.
      var label = document.createElement("span");
      label.className = "th-text";
      label.textContent = col.label;
      th.appendChild(label);
      th.title = "Click to sort by " + col.label;
      wireSortableHeader(th, col.key, state.t3Sort, renderTable3);
      thead.appendChild(th);
    });

    var procCol = state.schema.procedure_separation_type_column;

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="' + t1Columns().length + '" class="empty-state">No cohorts match these conditions.</td></tr>';
    } else {
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        var procVal = procCol ? String(r[procCol] || "").trim() : "";
        var accentColor = procedureTypeColor(procVal);
        // Same row-level accent pattern as Table 1/Table 2 -- see the
        // comment in renderTable1Body() for why this is set on the <tr>
        // itself.
        if (accentColor) {
          tr.classList.add("accent-row");
          tr.style.setProperty("--row-accent", accentColor);
          var rowTint = procedureTypeRowTint(procVal);
          if (rowTint) tr.style.setProperty("--row-tint", rowTint);
        }
        t1Columns().forEach(function (col, i) {
          var td = document.createElement("td");
          td.textContent = DD.formatValue(r[col.key]);
          if (i === 0 && accentColor) {
            td.classList.add("accent-cell");
          }
          tr.appendChild(td);
        });
        tr.style.cursor = "pointer";
        tr.title = "Click for full record";
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
            ? "Procedure Separation Type: " +
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
