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
    t1Sort: { column: null, direction: "asc" },
    // Table 2
    t2SelectedCohorts: null, // Set, populated once data loads
    t2SelectedColumns: null, // Set
    t2SelectedTypes: null, // Set of selected "Type N" values (Procedure Separation Type filter)
    t2Rendered: false, // see loadData()/wireTabs() -- deferred until the tab is visible
    // Table 3
    t3Conditions: [], // [{id, field, operator, value}]
    t3Mode: "all",
    t3ConditionIdSeq: 1,
    t3Rendered: false, // see loadData()/wireTabs() -- deferred until the tab is visible
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
      });
    });
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
      { key: "N", label: "N" },
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
    thead.innerHTML = "";
    t1Columns().forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col.label;
      th.title = "Click to sort by " + col.label;
      th.addEventListener("click", function () {
        if (state.t1Sort.column === col.key) {
          state.t1Sort.direction = state.t1Sort.direction === "asc" ? "desc" : "asc";
        } else {
          state.t1Sort.column = col.key;
          state.t1Sort.direction = "asc";
        }
        renderTable1Body();
      });
      if (state.t1Sort.column === col.key) {
        th.classList.add(state.t1Sort.direction === "asc" ? "sorted-asc" : "sorted-desc");
      }
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
    renderCategoryLegend("t2-legend");
    renderTable2Hint();
    renderTable2Body();
    syncChecklistHeight();
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

    // Only trust a group (at any depth) if its header and at least one of
    // its (possibly nested) descendants actually made it into this
    // dataset's checklist_columns (e.g. the small mock dataset doesn't
    // have most of these real columns, so schema.checklist_groups ends up
    // empty for it -- see build_schema() in fetch_data.py). Recursive
    // since a "child" can be another group object instead of a leaf
    // string.
    var allSet = {};
    allValues.forEach(function (v) {
      allSet[v] = true;
    });

    function filterGroup(g) {
      if (!allSet[g.header]) return null;
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

    // Every header or leaf value that appears anywhere in a filtered
    // group's subtree, gathered recursively -- used for the tri-state
    // checked/indeterminate calculation on a header's own checkbox
    // (`groupState`/`setGroupSelected`) and to know which top-level
    // values are "consumed" by a group (and so shouldn't also be drawn as
    // a standalone flat row in `draw()` below).
    function collectMembers(node) {
      var members = [node.header];
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

    var topLevelNodeByHeader = {};
    var consumedSet = {};
    (groups || []).forEach(function (g) {
      var filtered = filterGroup(g);
      if (!filtered) return;
      topLevelNodeByHeader[filtered.header] = filtered;
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

      allValues.forEach(function (val) {
        // Top-level group headers are rendered (together with their full,
        // possibly multi-level subtree) via renderNode() below.
        if (topLevelNodeByHeader[val]) {
          if (renderNode(topLevelNodeByHeader[val], 0, query)) renderedAny = true;
          return;
        }
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

  // Keeps the picker sidebar's rendered height in sync with the Coverage
  // Checklist *table's* rendered height. This used to run the other way --
  // table matched to sidebar -- so the table would stretch to show as many
  // rows as fit next to the (previously often-taller) sidebar. With the
  // full picker stack (Cohorts + Procedure Separation Type + Checklist
  // items, all three stacked in #t2-sidebar) now regularly taller than the
  // table's own row count needs, that direction left dead space below the
  // table's last row -- the table's box was forced tall enough to match the
  // sidebar, but its actual rows didn't fill it. Matching the *sidebar* to
  // the *table* instead means the table's box height is always exactly its
  // own content (no leftover space below the last row); the sidebar
  // scrolls internally (see "#t2-sidebar" in dashboard.css) if its pickers
  // add up to more than that height.
  //
  // The Procedure Separation Type key is deliberately NOT included in this
  // sync (it used to be) -- the key's own box now just hugs its own fixed
  // five-item content (see "#panel-checklist .panel-key" in dashboard.css
  // overriding the grid's default `align-items: stretch`), ending right
  // after its last line of text instead of being stretched down to match
  // the table, which left a slab of empty space below the key's content
  // whenever the table was taller than the key.
  //
  // Uses ResizeObserver (rather than a one-time measurement) since the
  // table's height itself changes -- row filtering, window resize, the tab
  // becoming visible for the first time, etc.
  var _checklistHeightObserver = null;
  function syncChecklistHeight() {
    var sidebar = document.getElementById("t2-sidebar");
    var tableScroll = document.getElementById("t2-table-scroll");
    if (!sidebar || !tableScroll) return;

    function apply() {
      // Clear any previously-applied height first so this always measures
      // the table's own natural size, not a stale value from an earlier
      // call (there's nothing else constraining #t2-table-scroll's height
      // -- see the "max-height: none" override for it in dashboard.css).
      tableScroll.style.height = "";
      var h = tableScroll.getBoundingClientRect().height;
      if (h > 0) {
        sidebar.style.height = h + "px";
      }
    }

    apply();

    if (!_checklistHeightObserver && window.ResizeObserver) {
      _checklistHeightObserver = new ResizeObserver(apply);
      _checklistHeightObserver.observe(tableScroll);
    }
  }

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

    var thead = table.querySelector("thead");
    var tbody = table.querySelector("tbody");
    thead.innerHTML = "";
    tbody.innerHTML = "";

    var headRow = document.createElement("tr");
    var cornerTh = document.createElement("th");
    cornerTh.className = "cohort-col-header";
    cornerTh.textContent = "Cohort";
    headRow.appendChild(cornerTh);

    // Procedure Separation Type gets its own dedicated column (showing
    // "Type N" text, not a Yes/No/Partial-classified chip like the
    // checklist items below), since it isn't a per-cohort yes/no item.
    var typeTh = document.createElement("th");
    typeTh.className = "type-col-header";
    typeTh.textContent = "Procedure separation type";
    headRow.appendChild(typeTh);

    columns.forEach(function (col) {
      var th = document.createElement("th");
      // The label text lives in its own inner span rather than directly on
      // the <th> -- see the ".th-label" rule in dashboard.css.
      var label = document.createElement("span");
      label.className = "th-label";
      label.textContent = col;
      th.appendChild(label);
      th.title = col;
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

        var typeTd = document.createElement("td");
        typeTd.className = "type-cell";
        typeTd.textContent = procVal || "\u2014";
        if (accentColor) {
          typeTd.style.color = accentColor;
        }
        // Custom tooltip (see attachTooltip() above) showing this type's
        // full definition -- the same text shown in the key/legend off to
        // the side (renderProcedureSeparationKey()) -- so hovering "Type 3"
        // here explains what that means without having to look it up
        // elsewhere. A short (500ms) delay, same as the value chips below,
        // rather than instant like the cohort name -- only the cohort name
        // (which is truncated and needs immediate confirmation of what it
        // says) gets the 0ms treatment.
        var typeDef = procedureTypeDefinition(procVal);
        if (typeDef) {
          attachTooltip(typeTd, typeDef, 500);
        }
        tr.appendChild(typeTd);

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

    var thead = table.querySelector("thead tr");
    var tbody = table.querySelector("tbody");
    thead.innerHTML = "";
    tbody.innerHTML = "";

    t1Columns().forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col.label;
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
        // Radius at the map's current zoom, derived from the cohort's N --
        // baseRadius itself never changes, but the on-screen size does as
        // the user zooms (see markerRadiusForZoom()/DD.zoomRadiusScale()),
        // so it's recomputed from this on every zoomend via
        // repositionJitteredMarkers() rather than baked into a fixed style.
        var baseRadius = DD.markerRadius(r.N);
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
          "N: " +
          escapeHtml(DD.formatValue(r.N)) +
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
