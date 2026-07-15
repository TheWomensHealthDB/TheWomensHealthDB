/*
 * dashboard.js
 *
 * DOM rendering + event wiring for the Women's Health Cohort Database
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
    // Table 1
    t1Sort: { column: null, direction: "asc" },
    // Table 2
    t2SelectedCohorts: null, // Set, populated once data loads
    t2SelectedColumns: null, // Set
    // Table 3
    t3Conditions: [], // [{id, field, operator, value}]
    t3Mode: "all",
    t3ConditionIdSeq: 1,
  };

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", function () {
    wireTabs();
    wireModal();
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

        renderDataSourceBanner();
        renderTable1();
        renderTable2();
        renderTable3Fields();
        renderTable3();
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
    backdrop.classList.add("open");
  }

  function renderDetailSection(title, columns, record) {
    if (!columns || !columns.length) return "";
    var html = "<h3>" + title + "</h3><dl>";
    columns.forEach(function (col) {
      html += "<dt>" + escapeHtml(col) + "</dt><dd>" + escapeHtml(DD.formatValue(record[col])) + "</dd>";
    });
    html += "</dl>";
    return html;
  }

  // ---------------------------------------------------------------------
  // Shared: categorical color legend (swatch + label pairs)
  // ---------------------------------------------------------------------

  function paletteLegendHtml(colorMap, caption) {
    if (!colorMap || !colorMap.size) return "";
    var html = "";
    if (caption) {
      html += '<span class="legend-caption">' + escapeHtml(caption) + "</span>";
    }
    colorMap.forEach(function (color, label) {
      html +=
        '<span class="legend-item"><span class="swatch" style="background:' +
        color +
        '"></span>' +
        escapeHtml(label) +
        "</span>";
    });
    return html;
  }

  // ---------------------------------------------------------------------
  // Table 1: Cohort summary
  // ---------------------------------------------------------------------

  var T1_COLUMNS = null; // resolved once schema is known
  var T1_PROC_COLOR_MAP = null; // resolved once cohorts are known

  function t1Columns() {
    if (T1_COLUMNS) return T1_COLUMNS;
    var procCol = state.schema.procedure_separation_type_column;
    T1_COLUMNS = [
      { key: state.schema.cohort_name_column, label: "Cohort Name" },
      { key: procCol, label: "Procedure Separation Type" },
      { key: "N", label: "N" },
      { key: "Age Range", label: "Age Range" },
      { key: "%male/%female", label: "%male/%female" },
    ];
    return T1_COLUMNS;
  }

  function t1ProcedureColorMap() {
    if (T1_PROC_COLOR_MAP) return T1_PROC_COLOR_MAP;
    var procCol = state.schema.procedure_separation_type_column;
    T1_PROC_COLOR_MAP = DD.paletteFor(
      state.cohorts.map(function (c) {
        return procCol ? c[procCol] : "";
      })
    );
    return T1_PROC_COLOR_MAP;
  }

  function renderTable1() {
    var searchInput = document.getElementById("t1-search");
    if (searchInput && !searchInput._wired) {
      searchInput.addEventListener("input", renderTable1Body);
      searchInput._wired = true;
    }
    var legendEl = document.getElementById("t1-legend");
    if (legendEl) {
      legendEl.innerHTML = paletteLegendHtml(t1ProcedureColorMap(), "Row color \u2014 Procedure Separation Type:");
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
    var colorMap = t1ProcedureColorMap();

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
        var accentColor = procVal ? colorMap.get(procVal) : null;

        t1Columns().forEach(function (col, i) {
          var td = document.createElement("td");
          td.textContent = DD.formatValue(r[col.key]);
          if (i === 0 && accentColor) {
            td.classList.add("accent-cell");
            td.style.setProperty("--row-accent", accentColor);
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
    renderPicker("t2-column-picker", state.schema.checklist_columns || [], state.t2SelectedColumns, renderTable2Body);
    renderCategoryLegend("t2-legend");
    renderTable2Hint();
    renderTable2Body();
  }

  function renderTable2Hint() {
    var el = document.getElementById("t2-hint-text");
    if (!el) return;
    var total = (state.schema.checklist_columns || []).length;
    el.textContent =
      "This matrix covers " +
      total +
      " questionnaire item(s) across all cohorts. Use the pickers on the left to narrow " +
      "which cohorts and items are shown. Hover a colored cell to see its exact response " +
      "text, and click a cohort name for its full record.";
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
    var columns = (state.schema.checklist_columns || []).filter(function (c) {
      return state.t2SelectedColumns.has(c);
    });
    var rows = state.cohorts.filter(function (r) {
      return state.t2SelectedCohorts.has(r[nameCol]);
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
    columns.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col;
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
        var nameTd = document.createElement("td");
        nameTd.className = "cohort-cell";
        nameTd.textContent = r[nameCol];
        nameTd.title = "Click for full record";
        nameTd.addEventListener("click", function () {
          openCohortDetail(r);
        });
        tr.appendChild(nameTd);

        columns.forEach(function (col) {
          var td = document.createElement("td");
          var classified = DD.classifyValue(r[col]);
          var chip = document.createElement("span");
          chip.className = "chip cat-" + classified.category;
          chip.title = col + ": " + (classified.label || "(no data)");
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
        // "other" (free text) -- show a short version of the raw label
        return label && label.length <= 12 ? label : "\u2022";
    }
  }

  // ---------------------------------------------------------------------
  // Table 3: AND/OR filter builder
  // ---------------------------------------------------------------------

  function t3AllFields() {
    var s = state.schema;
    return []
      .concat(s.metadata_columns || [])
      .concat(s.validity_columns || [])
      .concat(s.checklist_columns || []);
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
        opt.textContent = f;
        if (f === cond.field) opt.selected = true;
        fieldSelect.appendChild(opt);
      });
      fieldSelect.addEventListener("change", function () {
        cond.field = fieldSelect.value;
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
      valueInput.value = cond.value;
      valueInput.style.display = op_needsValue(cond.operator) ? "" : "none";
      valueInput.addEventListener("input", function () {
        cond.value = valueInput.value;
        renderTable3();
      });

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

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="' + t1Columns().length + '" class="empty-state">No cohorts match these conditions.</td></tr>';
    } else {
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        t1Columns().forEach(function (col) {
          var td = document.createElement("td");
          td.textContent = DD.formatValue(r[col.key]);
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
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    state.map = map;
    renderMapMarkers();
    setTimeout(function () {
      map.invalidateSize();
    }, 0);
  }

  function renderMapMarkers() {
    if (!state.map) return;
    var procCol = state.schema.procedure_separation_type_column;
    var nameCol = state.schema.cohort_name_column;

    var geocoded = state.cohorts.filter(function (r) {
      return typeof r.Latitude === "number" && typeof r.Longitude === "number";
    });

    var colorMap = DD.paletteFor(
      geocoded.map(function (r) {
        return r[procCol];
      })
    );

    if (state.mapLayer) {
      state.map.removeLayer(state.mapLayer);
    }
    var layer = L.layerGroup();

    geocoded.forEach(function (r) {
      var typeVal = r[procCol] ? String(r[procCol]).trim() : "";
      var color = colorMap.get(typeVal) || "#666";
      var baseStyle = {
        radius: DD.markerRadius(r.N),
        color: color,
        fillColor: color,
        fillOpacity: 0.65,
        weight: 1.5,
      };
      var hoverStyle = {
        radius: baseStyle.radius + 4,
        color: color,
        fillColor: color,
        fillOpacity: 0.9,
        weight: 3,
      };
      var marker = L.circleMarker([r.Latitude, r.Longitude], baseStyle);

      var tooltipHtml =
        '<div class="cohort-tooltip"><strong>' +
        escapeHtml(r[nameCol] || "") +
        "</strong>" +
        (typeVal ? escapeHtml(typeVal) + "<br/>" : "") +
        "N: " +
        escapeHtml(DD.formatValue(r.N)) +
        "<br/>" +
        "Age range: " +
        escapeHtml(DD.formatValue(r["Age Range"])) +
        "<br/>" +
        "%male/%female: " +
        escapeHtml(DD.formatValue(r["%male/%female"])) +
        '<span class="tooltip-hint">Click marker for full details</span>' +
        "</div>";
      marker.bindTooltip(tooltipHtml);

      // Highlight on hover (in addition to the tooltip Leaflet already
      // shows) so it's visually obvious which cohort you're pointing at,
      // especially when markers are close together.
      marker.on("mouseover", function () {
        marker.setStyle(hoverStyle);
        marker.bringToFront();
      });
      marker.on("mouseout", function () {
        marker.setStyle(baseStyle);
      });
      marker.on("click", function () {
        openCohortDetail(r);
      });
      layer.addLayer(marker);
    });

    layer.addTo(state.map);
    state.mapLayer = layer;

    renderMapLegend(colorMap);

    var missing = state.cohorts.length - geocoded.length;
    var noteEl = document.getElementById("map-note");
    if (noteEl) {
      noteEl.textContent = missing > 0 ? missing + " cohort(s) omitted (no geocodable location)." : "";
    }
  }

  function renderMapLegend(colorMap) {
    var el = document.getElementById("map-legend");
    if (!el) return;
    el.innerHTML = paletteLegendHtml(colorMap, colorMap.size ? "Marker color \u2014 Procedure Separation Type:" : "");
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
