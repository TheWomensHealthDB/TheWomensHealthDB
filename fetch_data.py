"""
fetch_data.py

Authenticates to the Google Sheets API with a service-account credential and
pulls both source tabs -- "Complete Datasets" and "Table" -- then builds the
JSON files the dashboard front-end reads directly:

    charts/data/complete_datasets.json  -- raw "Complete Datasets" tab rows
    charts/data/table.json              -- raw "Table" tab rows (flattened
                                            two-row header)
    charts/data/cohorts.json            -- the two tabs joined on cohort
                                            name, plus geocoded Latitude /
                                            Longitude for the map
    charts/data/schema.json             -- which columns are "metadata"
                                            (cohort characteristics) vs.
                                            "checklist" (women's-health item
                                            yes/no/some columns) vs.
                                            "validity" (from the Table tab),
                                            so the dashboard doesn't have to
                                            hardcode ~90 column names

Unlike the earlier "publish to web" approach, the sheet itself is never made
public: it's shared only with the service account's email address, and this
script reads it over an authenticated API call. See README.md for the
one-time Google Cloud setup steps (create project, enable Sheets API, create
service account + key, share the sheet with it).

Required environment variables:
    GOOGLE_CREDENTIALS  -- full contents of the service account's JSON key
                           file. Store as a GitHub Actions Secret (Settings
                           -> Secrets and variables -> Actions -> Secrets).
    SPREADSHEET_ID      -- the Google Sheet's ID, found in its URL:
                           https://docs.google.com/spreadsheets/d/<THIS PART>/edit
                           Not sensitive on its own (useless without the
                           credential above), so it can live as a plain repo
                           Variable if you'd rather not treat it as a secret
                           -- either works, since it's just read from the
                           environment either way.

If either variable isn't set (e.g. running locally before the Google Cloud
setup is done), this script falls back to small mock datasets shaped like
the real tabs, so the fetch step and downstream dashboard code stay
testable end to end.
"""

import json
import math
import re
import sys
import os
from pathlib import Path

import pandas as pd

from country_centroids import geocode_country
from state_centroids import geocode_state
from participant_location import resolve_participant_location

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

GOOGLE_CREDENTIALS = os.environ.get("GOOGLE_CREDENTIALS", "").strip()
SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID", "").strip()

OUTPUT_DIR = Path("charts/data")

COMPLETE_DATASETS_TAB = "Complete Datasets"
TABLE_TAB = "Table"

# Columns in "Complete Datasets" that describe the cohort itself, as opposed
# to the ~90 "does this cohort ask about X" women's-health item columns.
# Everything else in the tab is treated as a checklist column automatically
# -- see build_schema() -- so this list only needs to name the handful of
# non-checklist columns, not maintain the full ~90-column list.
#
# NOTE: this is a best-effort guess based on the header names shared before
# real data was connected. Once the live sheet is wired up, sanity-check
# `charts/data/schema.json` and adjust this list if anything looks
# miscategorized (e.g. if "Sex Hormones/Biomarkers collected?" etc. should
# be treated as metadata rather than checklist items).
# Raw free-text columns used to derive RESOLVED_LOCATION_COLUMN (see
# participant_location.py for the resolution rules). Never shown directly
# anywhere in the dashboard -- see EXCLUDED_COLUMNS below -- only the
# cleaned-up RESOLVED_LOCATION_COLUMN they produce is.
SUBJECT_POPULATION_LOCATION_COLUMN = "Subject population location"
PI_LOCATION_COLUMN = (
    "State/Territory (*location of PI/study, not necessarily where the "
    "data/cohort is collected)"
)

# Computed (not a real sheet column) -- added to every row of "Complete
# Datasets" by _add_resolved_location_column() below, from
# SUBJECT_POPULATION_LOCATION_COLUMN and PI_LOCATION_COLUMN. This is what
# drives the map's marker placement (see build_cohorts()) and is the
# single, clearly-labeled location value shown in the dashboard (Cohort
# Summary/detail "Overview" section, Custom Filter, map tooltip) in place of
# the raw, inconsistently-formatted source columns.
RESOLVED_LOCATION_COLUMN = "Location of Cohort's Participants (or of PI, if Unlisted/Multiple/Nationwide)"

# The raw sheet's sex-composition column has already been renamed at least
# once (originally "%male/%female", holding a paired "0/100"-style value;
# as of 2026 it's just "%female." holding a single percentage) and may well
# be spelled/punctuated slightly differently again in the future. Rather
# than hardcoding the current exact raw header text everywhere downstream
# (METADATA_COLUMNS, dashboard.js, mock data, etc.), _rename_sex_composition
# _column() below detects any of these variants by a loose regex and
# renames the column to this one stable, code-defined name -- same pattern
# as RESOLVED_LOCATION_COLUMN above.
SEX_COMPOSITION_COLUMN = "% Female"

# Matches "%male/%female", "%female", "%female.", "% Female", "female", etc.
# (case/whitespace/trailing-period insensitive) -- but not arbitrary other
# text that merely mentions "female" somewhere in a longer sentence, since
# this is a *whole-header* match, not a substring search.
_SEX_COMPOSITION_HEADER_RE = re.compile(
    r"^%?\s*(?:male\s*/\s*)?%?\s*female\.?$", re.IGNORECASE
)


def _rename_sex_composition_column(header: "list[str]") -> "list[str]":
    """
    Renames whichever raw header spelling of the sex-composition column is
    present (see _SEX_COMPOSITION_HEADER_RE) to the stable
    SEX_COMPOSITION_COLUMN name, so downstream code (METADATA_COLUMNS,
    dashboard.js, etc.) only ever has to know about one name regardless of
    how the sheet's header text is currently spelled/punctuated.
    """
    return [
        SEX_COMPOSITION_COLUMN if _SEX_COMPOSITION_HEADER_RE.match(h.strip()) else h
        for h in header
    ]


# The raw sheet's column for this was originally named "Wording of Related
# Questions/Variables" -- too generic given it's specifically about
# hysterectomy/oophorectomy question wording, easy to confuse with the ~90
# other "related questions/variables" style columns. Same rename-to-a-
# stable-name pattern as RESOLVED_LOCATION_COLUMN/SEX_COMPOSITION_COLUMN
# above: HEADER_STANDARDIZATION_MAP below maps the raw header to this name,
# so it only needs to be defined once here.
HYSTERECTOMY_OOPHORECTOMY_RELATED_COLUMN = (
    "Hysterectomy and Oophorectomy Related Questions/Variables"
)

METADATA_COLUMNS = [
    "Cohort Name",
    # Was "Location" -- the raw sheet's column of this kind is now named
    # "Country" (this was silently dropping the field from the Overview
    # section/Cohort Summary table entirely, since it never matched any
    # real column, rather than showing blank -- unlike a genuinely blank
    # cell, "not in complete_df.columns at all" isn't warned about).
    "Country",
    "Public Availability",
    "N",
    "Age Range",
    SEX_COMPOSITION_COLUMN,
    "Year Started/Wave Description",
    HYSTERECTOMY_OOPHORECTOMY_RELATED_COLUMN,
    RESOLVED_LOCATION_COLUMN,
]

COHORT_NAME_COLUMN = "Cohort Name"
TABLE_COHORT_COLUMN = "Cohort"

# Cohorts to drop entirely from every published output (complete_datasets
# .json, table.json, and -- since it's built from those two -- cohorts.json)
# even though they're still present in the raw sheet. Use this for a cohort
# that's been cut from the project but hasn't been deleted from the source
# spreadsheet yet, rather than waiting on that spreadsheet edit.
#
# Matched case-/whitespace-insensitively as a *whole word* anywhere in the
# cohort name (see _is_excluded_cohort() below) -- not just a prefix -- so a
# single "RANN" entry here catches every way the raw sheet currently spells
# this one out: "RANN (Columbia PI Stern)" (starts with it) *and*
# "Reference Ability Neural Network (RANN)" (has it parenthesized at the
# end). Word-boundary matching means it won't accidentally catch an
# unrelated cohort whose name merely contains "rann" as part of a longer
# word (e.g. a hypothetical "Brannigan Study").
EXCLUDED_COHORTS = [
    "RANN",
]

# Columns in "Complete Datasets" that should never show up anywhere in the
# dashboard (not in the Coverage Checklist table, not as a checklist-item
# option, not in the detail modal, not as a Custom Filter field) -- as
# opposed to METADATA_COLUMNS above, which *are* shown, just in the Cohort
# Summary/detail "Overview" section rather than as a checklist item.
#
# SUBJECT_POPULATION_LOCATION_COLUMN and PI_LOCATION_COLUMN are excluded
# here (rather than added to METADATA_COLUMNS) because they're the messy
# raw inputs to RESOLVED_LOCATION_COLUMN, not something worth showing on
# their own -- same reasoning as "State (if applicable)".
EXCLUDED_COLUMNS = [
    "State (if applicable)",
    SUBJECT_POPULATION_LOCATION_COLUMN,
    PI_LOCATION_COLUMN,
]

# Raw-header -> standardized-header text for checklist/metadata columns
# whose exact wording in the live sheet has inconsistencies we don't want
# showing up in the dashboard: trailing colons ("Hot flashes item:"),
# inconsistent capitalization ("sex of live births item"), a typo
# ("Oopherectomy" -> "Oophorectomy"), "item" suffix missing on a few
# outliers, and "HT" abbreviated inconsistently next to the fully-spelled-
# out "Hormone therapy ..." columns elsewhere in the same list.
#
# Only columns that actually need a text change are listed here -- anything
# not in this dict passes through unchanged. Keys are matched against the
# raw header text after stripping whitespace (case-sensitive, since we're
# matching the sheet's exact known current wording rather than guessing at
# variants -- unlike _SEX_COMPOSITION_HEADER_RE/RESOLVED_LOCATION_COLUMN,
# which have to tolerate the sheet's header text drifting over time).
#
# NOTE: deliberately excludes the "if yes ..." follow-up columns (e.g. "If
# yes type item") -- those are handled by FOLLOWUP_DISTINGUISHING_OVERRIDES
# / _build_followup_label() below instead, since their final label also
# needs to reference the base item they follow, not just a straight
# rename. _standardize_headers() below skips any header matching
# FOLLOWUP_HEADER_RE for this reason.
HEADER_STANDARDIZATION_MAP = {
    # Per the audit spreadsheet's decision column: drop the "Question
    # Included" suffix on this whole cluster in favor of the majority
    # "item" convention used everywhere else.
    "Hysterectomy Question Included": "Hysterectomy item",
    "Oopherectomy Question Included": "Oophorectomy item",
    "Date of Menses Question Included": "Date of menses item",
    "FMP Date Question Included": "FMP date item",
    "Pregnancy Question Included": "Pregnancy item",
    "Other Women's Health Questions": "Other women's health item",
    "Wording of Related Questions/Variables": HYSTERECTOMY_OOPHORECTOMY_RELATED_COLUMN,
    "Age at menarche": "Age at menarche item",
    "PCOS/PMOS Item": "PCOS/PMOS item",
    "POI Item": "POI item",
    "Pelvic cancer (cancer of the vulva, cervix, uterus, or ovaries) item:": (
        "Pelvic cancer (cancer of the vulva, cervix, uterus, or ovaries) item"
    ),
    "Abnormal vaginal bleeding": "Abnormal vaginal bleeding item",
    "Fibroids (benign growths in the uterus or womb) item:": (
        "Fibroids (benign growths in the uterus or womb) item"
    ),
    "Age at pregnancies item:": "Age at pregnancies item",
    "Type of Pregnancy item": "Type of pregnancy item",
    "sex of live births item": "Sex of live births item",
    "breastfeeding item": "Breastfeeding item",
    "Time of breastfeeding": "Time of breastfeeding item",
    "Fertility medications to help you get pregnant item:": (
        "Fertility medications to help you get pregnant item"
    ),
    "Menopausal status item:": "Menopausal status item",
    "Cycle regularity item:": "Cycle regularity item",
    "Bleeding flow / amount item:": "Bleeding flow / amount item",
    "Length of time without a period (amenorrhea) item:": (
        "Length of time without a period (amenorrhea) item"
    ),
    "Vasomotor symptoms:": "Vasomotor symptom items",
    "Vasomotor symptoms": "Vasomotor symptom items",
    "Hot flashes item:": "Hot flashes item",
    "Night sweats item:": "Night sweats item",
    # Per the audit sheet: this one keeps its "item" suffix but gets
    # "(general)" added, since it's distinguished from the more specific
    # "Pain inside vagina during intercourse item" right after it.
    "Pain during intercourse item": "Pain during intercourse (general) item",
    # Per the audit sheet: these describe all checklist items generally
    # (not a single item each), so they get pluralized to "items".
    "Symptom severity item": "Symptom severity items",
    "Symptom time frame item": "Symptom time frame items",
    "Knowledge of menopause": "Knowledge of menopause item",
    "Views or perceptions of menopause": "Views or perceptions of menopause item",
    "Sources of knowledge about menopause": "Sources of knowledge about menopause item",
    "Knowledge of HT": "Knowledge of hormone therapy item",
    "Views or perceptions of HT": "Views or perceptions of hormone therapy item",
    "Sources of knowledge about HT": "Sources of knowledge about hormone therapy item",
    # Per the audit sheet: reworded to a "...?" phrasing, and "Cognitive
    # Variables"/"Neuroimaging Variables" reworded to specify "data
    # collected" rather than just "Variables".
    "Sex Hormones/Biomarkers collected?": "Sex hormones/biomarkers collected?",
    "Health Records Linked": "Health records linked?",
    "Cognitive Variables": "Cognitive data collected?",
    "Neuroimaging Variables": "Neuroimaging data collected?",
    # Per the audit spreadsheet's decision column: these 6 remaining symptom
    # sub-group headers all get "symptoms" -> singular "symptom" + "items"
    # suffix, matching "Vasomotor symptom items" above -- and, per the same
    # sheet, all 7 of these become nested children of the
    # "Menopause-related symptom items" umbrella header instead of
    # standalone top-level items (see CHECKLIST_SECTION_GROUPS below).
    "Sleep symptoms": "Sleep symptom items",
    "Somatic symptoms": "Somatic symptom items",
    "Mood symptoms item": "Mood symptom items",
    "Cognitive symptoms item": "Cognitive symptom items",
    "Genitourinary symptoms item": "Genitourinary symptom items",
    "Sexual/libido symptoms item": "Sexual/libido symptom items",
}

# Matches a checklist column's header text when it's a "if yes, type item"
# -style follow-up to the item immediately before it (e.g. "if yes, type
# item", "If Yes, Type Item:"). Matched loosely (just the leading "if yes")
# rather than requiring an exact literal string, since the real sheet may
# reuse this same header text for many different follow-up columns.
FOLLOWUP_HEADER_RE = re.compile(r"^\s*if\s+yes\b", re.IGNORECASE)


def _standardize_headers(header: "list[str]") -> "list[str]":
    """
    Applies HEADER_STANDARDIZATION_MAP to every header that isn't itself a
    "if yes ..." follow-up column (those are left untouched here so
    FOLLOWUP_HEADER_RE/_process_followup_columns() below still see the raw
    "if yes" text they match against -- see _build_followup_label() for how
    follow-up columns get their own standardized-ish text instead).
    """
    result = []
    for h in header:
        stripped = h.strip()
        if FOLLOWUP_HEADER_RE.match(stripped):
            result.append(h)
        else:
            result.append(HEADER_STANDARDIZATION_MAP.get(stripped, h))
    return result

# Normalized tokens treated as an affirmative ("Yes") response, used to
# decide whether a follow-up "if yes, type item" column's value should be
# kept or blanked out for a given cohort. Mirrors the YES set in
# charts/dashboard-data.js so the two stay in sync.
_YES_TOKENS = {"yes", "y", "true", "included", "1"}


def _client():
    """Builds an authenticated gspread client from GOOGLE_CREDENTIALS."""
    import gspread
    from google.oauth2.service_account import Credentials

    creds_info = json.loads(GOOGLE_CREDENTIALS)
    creds = Credentials.from_service_account_info(creds_info, scopes=SCOPES)

    return gspread.authorize(creds)


def _mock_complete_datasets() -> pd.DataFrame:
    """
    Small mock dataset shaped like the real 'Complete Datasets' tab --
    several countries (including repeats, to exercise map-marker jitter)
    and a broader set of representative checklist columns (yes / no / "to
    some extent" / free-text) so the Coverage Checklist tab previews with
    more than a token handful of items when running without live
    credentials. The real spreadsheet has ~90 checklist columns; this mock
    set is intentionally smaller but varied enough to exercise every chip
    type the dashboard renders.
    """
    rows = [
        {
            "Cohort Name": "Example Cohort A",
            "Country": "United States",
            "Public Availability": "Yes",
            "N": 1200,
            "Age Range": "40-60",
            SEX_COMPOSITION_COLUMN: "100%",
            "Year Started/Wave Description": "Wave 1: 2005",
            "Hysterectomy Question Included": "Yes",
            "Oophorectomy Question Included": "No",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "To some extent",
            "Hot flashes item": "Yes",
            "Night sweats item": "To some extent",
            "Birth control usage item": "Yes",
            "Menopause Status Item": "Yes",
            "Endometriosis Item": "No",
            "Fibroids Item": "To some extent",
            "Contraceptive Type Item": "IUD, Pill, Other",
            "Sleep Quality Item": "Yes",
            "Mental Health Screening Item": "Yes",
            "BMI/Weight Item": "Yes",
            "Family History Item": "To some extent",
        },
        {
            "Cohort Name": "Example Cohort B",
            "Country": "United Kingdom",
            "Public Availability": "No",
            "N": 850,
            "Age Range": "35-55",
            SEX_COMPOSITION_COLUMN: "100%",
            "Year Started/Wave Description": "Wave 1: 1998",
            "Hysterectomy Question Included": "No",
            "Oophorectomy Question Included": "No",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "No",
            "Hot flashes item": "No",
            "Night sweats item": "No",
            "Birth control usage item": "No",
            "Menopause Status Item": "No",
            "Endometriosis Item": "No",
            "Fibroids Item": "No",
            "Contraceptive Type Item": "",
            "Sleep Quality Item": "No",
            "Mental Health Screening Item": "No",
            "BMI/Weight Item": "Yes",
            "Family History Item": "No",
        },
        {
            "Cohort Name": "Example Cohort C",
            "Country": "United States",
            "Public Availability": "Yes",
            "N": 3400,
            "Age Range": "18-45",
            SEX_COMPOSITION_COLUMN: "55%",
            "Year Started/Wave Description": "Wave 1: 2012",
            "Hysterectomy Question Included": "Yes",
            "Oophorectomy Question Included": "Yes",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "Yes",
            "Hot flashes item": "To some extent",
            "Night sweats item": "No",
            "Birth control usage item": "Yes",
            "Menopause Status Item": "To some extent",
            "Endometriosis Item": "Yes",
            "Fibroids Item": "Yes",
            "Contraceptive Type Item": "Pill, Condom",
            "Sleep Quality Item": "Yes",
            "Mental Health Screening Item": "Yes",
            "BMI/Weight Item": "Yes",
            "Family History Item": "Yes",
        },
        {
            "Cohort Name": "Example Cohort D",
            "Country": "United Kingdom",
            "Public Availability": "Yes",
            "N": 2100,
            "Age Range": "50-70",
            SEX_COMPOSITION_COLUMN: "100%",
            "Year Started/Wave Description": "Wave 1: 2001",
            "Hysterectomy Question Included": "Yes",
            "Oophorectomy Question Included": "To some extent",
            "Pregnancy Question Included": "No",
            "PCOS/PMOS Item": "No",
            "Hot flashes item": "Yes",
            "Night sweats item": "Yes",
            "Birth control usage item": "No",
            "Menopause Status Item": "Yes",
            "Endometriosis Item": "To some extent",
            "Fibroids Item": "No",
            "Contraceptive Type Item": "",
            "Sleep Quality Item": "To some extent",
            "Mental Health Screening Item": "No",
            "BMI/Weight Item": "Yes",
            "Family History Item": "To some extent",
        },
        {
            "Cohort Name": "Example Cohort E",
            "Country": "Canada",
            "Public Availability": "No",
            "N": 640,
            "Age Range": "45-65",
            SEX_COMPOSITION_COLUMN: "100%",
            "Year Started/Wave Description": "Wave 1: 2010",
            "Hysterectomy Question Included": "Yes",
            "Oophorectomy Question Included": "Yes",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "No",
            "Hot flashes item": "Yes",
            "Night sweats item": "Yes",
            "Birth control usage item": "Yes",
            "Menopause Status Item": "Yes",
            "Endometriosis Item": "No",
            "Fibroids Item": "No",
            "Contraceptive Type Item": "IUD",
            "Sleep Quality Item": "Yes",
            "Mental Health Screening Item": "Yes",
            "BMI/Weight Item": "No",
            "Family History Item": "No",
        },
        {
            "Cohort Name": "Example Cohort F",
            "Country": "Australia",
            "Public Availability": "Yes",
            "N": 980,
            "Age Range": "40-55",
            SEX_COMPOSITION_COLUMN: "100%",
            "Year Started/Wave Description": "Wave 1: 2009",
            "Hysterectomy Question Included": "No",
            "Oophorectomy Question Included": "No",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "To some extent",
            "Hot flashes item": "No",
            "Night sweats item": "No",
            "Birth control usage item": "No",
            "Menopause Status Item": "No",
            "Endometriosis Item": "No",
            "Fibroids Item": "To some extent",
            "Contraceptive Type Item": "Pill",
            "Sleep Quality Item": "No",
            "Mental Health Screening Item": "To some extent",
            "BMI/Weight Item": "Yes",
            "Family History Item": "No",
        },
        {
            "Cohort Name": "Example Cohort G",
            "Country": "Netherlands",
            "Public Availability": "Yes",
            "N": 1750,
            "Age Range": "30-50",
            SEX_COMPOSITION_COLUMN: "50%",
            "Year Started/Wave Description": "Wave 1: 2015",
            "Hysterectomy Question Included": "Yes",
            "Oophorectomy Question Included": "No",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "Yes",
            "Hot flashes item": "Yes",
            "Night sweats item": "To some extent",
            "Birth control usage item": "Yes",
            "Menopause Status Item": "To some extent",
            "Endometriosis Item": "Yes",
            "Fibroids Item": "Yes",
            "Contraceptive Type Item": "IUD, Pill",
            "Sleep Quality Item": "Yes",
            "Mental Health Screening Item": "Yes",
            "BMI/Weight Item": "Yes",
            "Family History Item": "Yes",
        },
        {
            "Cohort Name": "Example Cohort H",
            "Country": "Japan",
            "Public Availability": "No",
            "N": 510,
            "Age Range": "42-58",
            SEX_COMPOSITION_COLUMN: "100%",
            "Year Started/Wave Description": "Wave 1: 2007",
            "Hysterectomy Question Included": "No",
            "Oophorectomy Question Included": "No",
            "Pregnancy Question Included": "No",
            "PCOS/PMOS Item": "No",
            "Hot flashes item": "Yes",
            "Night sweats item": "No",
            "Birth control usage item": "No",
            "Menopause Status Item": "No",
            "Endometriosis Item": "No",
            "Fibroids Item": "No",
            "Contraceptive Type Item": "",
            "Sleep Quality Item": "No",
            "Mental Health Screening Item": "No",
            "BMI/Weight Item": "No",
            "Family History Item": "No",
        },
    ]

    # (Subject population location, PI/study location) pairs for each mock
    # cohort above, in order -- deliberately chosen to exercise every format
    # variation resolve_participant_location() needs to handle: a single
    # "City, State"; a single country; multiple locations listed (falls back
    # to PI); "Nationwide" (falls back to PI); a bare city with no state
    # (resolved via the city lookup table); an unresolvable value with no
    # usable fallback (left unplaced on the map); multiple countries listed
    # (falls back to PI); and a blank subject population location (falls
    # back to PI).
    mock_spl_pi = [
        ("Los Angeles, CA", "California"),
        ("United Kingdom", ""),
        ("Boston, MA and New York, NY", "Massachusetts"),
        ("Nationwide", "United Kingdom"),
        ("Chicago", ""),
        ("Melbourne", "Australia"),
        ("Netherlands, Germany", "Netherlands"),
        ("", "Texas"),
    ]
    for row, (spl, pi) in zip(rows, mock_spl_pi):
        resolved, _source = resolve_participant_location(spl, pi)
        row[RESOLVED_LOCATION_COLUMN] = resolved or ""

    return pd.DataFrame(rows)


def _mock_table() -> pd.DataFrame:
    """Small mock dataset shaped like the real 'Table' tab (flattened headers)."""
    rows = [
        ("Example Cohort A", "Direct", "N/A", "Prospective", "Annual"),
        ("Example Cohort B", "Indirect", "Self-report", "Retrospective", "One-time"),
        ("Example Cohort C", "Direct", "N/A", "Prospective", "Biennial"),
        ("Example Cohort D", "Mixed", "Self-report", "Prospective", "Annual"),
        ("Example Cohort E", "Direct", "N/A", "Prospective", "Annual"),
        ("Example Cohort F", "Indirect", "Self-report", "Retrospective", "One-time"),
        ("Example Cohort G", "Direct", "N/A", "Prospective", "Biennial"),
        ("Example Cohort H", "Mixed", "Self-report", "Retrospective", "One-time"),
    ]
    return pd.DataFrame(
        rows,
        columns=[
            "Cohort",
            "Classification Validity - Procedure Separation Type",
            "Classification Validity - Other Factors",
            "Temporal Validity - Collection Design",
            "Temporal Validity - Follow-up Interval",
        ],
    )


def _dedupe_columns(columns: "list[str]") -> "list[str]":
    """
    Renames any duplicate column names by appending " (2)", " (3)", etc. to
    the 2nd/3rd/... occurrence, and warns about it.

    A live spreadsheet can end up with two columns sharing the exact same
    header text -- a copy/paste slip, or (for the "Table" tab) a merged-cell
    flattening quirk -- and left alone, that crashes
    pd.DataFrame.to_json(orient="records") with a bare "columns must be
    unique" error at the very end of the script, with no indication of
    *which* columns collided. Deduping here instead keeps the pipeline
    running (so everything else still gets published) while still
    surfacing exactly what collided, so it can be fixed at the source.
    """
    seen = {}
    result = []
    duplicates = set()
    for col in columns:
        count = seen.get(col, 0) + 1
        seen[col] = count
        if count == 1:
            result.append(col)
        else:
            duplicates.add(col)
            result.append(f"{col} ({count})")
    if duplicates:
        _warn(
            f"Found duplicate column header(s): {sorted(duplicates)}. "
            f"Renamed the repeats with a ' (2)', ' (3)', etc. suffix so the "
            f"pipeline doesn't crash, but this usually means two columns in "
            f"the sheet accidentally share the exact same header text -- "
            f"worth fixing at the source so the renamed one doesn't stay "
            f"mislabeled."
        )
    return result


def _warn(message: str) -> None:
    """
    Prints a warning to stderr. When running inside GitHub Actions, also
    emits it using the '::warning::' workflow command so it shows up as a
    yellow annotation on the run summary/PR diff -- not just buried in the
    raw step log, which is easy to miss (e.g. silently falling back to mock
    data because a secret wasn't actually wired up).
    """
    print(f"Warning: {message}", file=sys.stderr)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::warning::{message}")


def _is_yes(value) -> bool:
    """Normalizes a cell value and checks it against _YES_TOKENS."""
    if value is None:
        return False
    text = str(value).strip().lower()
    text = re.sub(r"[.,]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text in _YES_TOKENS


# Exact-raw-header -> hand-written "distinguishing" phrase for follow-up
# columns whose raw text (once the leading "if yes" is stripped) reads too
# awkwardly to show as-is -- e.g. "when start item:" -> "Age when started
# using birth control". The sheet reuses generic follow-up header text
# across several different base items (two separate "type"-style
# follow-ups under two different base items, for instance), so these are
# keyed by the *exact* raw header text (which does differ between them,
# e.g. "If yes type item" vs. "If yes, type") rather than by base item, and
# checked before falling back to the generic stripping logic in
# _build_followup_label() below for any follow-up not listed here.
#
# NOTE: "when start" is genuinely ambiguous between "age when started" and
# "calendar year/date when started" -- read as age here since that matches
# how the adjacent "duration of use" column is phrased, but worth
# double-checking against the sheet/audit spreadsheet if that's wrong.
FOLLOWUP_DISTINGUISHING_OVERRIDES = {
    "If yes type item": "Type of birth control used",
    "If yes Primary reason for taking birth control pills item:": (
        "Primary reason for taking birth control pills"
    ),
    "If yes when start item:": "Age when started using birth control",
    "If yes duration of use item": "Duration of birth control use",
    "If yes, type": "Type of fertility medication used",
}


def _build_followup_label(base_name: str, raw_followup_header: str) -> str:
    """
    Turns a base checklist item's header (e.g. "Birth control usage item")
    and the follow-up column's own raw header (e.g. "If yes Primary reason
    for taking birth control pills item:") into a label that keeps the
    follow-up's own distinguishing text while making unambiguous which base
    item it follows, e.g. 'Primary reason for taking birth control pills
    item (if yes, for "Birth control usage item")'.

    A single base item can have *several* consecutive follow-up columns
    (e.g. "Birth control usage item" is followed by 4: type, primary
    reason, when start, duration of use) -- keeping each follow-up's own
    text (rather than always inserting a generic "type") is what keeps
    those 4 from all colliding into one identical, indistinguishable label.
    """
    base_name = base_name.strip()
    raw_followup_header = raw_followup_header.strip()

    if raw_followup_header in FOLLOWUP_DISTINGUISHING_OVERRIDES:
        distinguishing = FOLLOWUP_DISTINGUISHING_OVERRIDES[raw_followup_header]
    else:
        # Strip the leading "if yes[,]" prefix, keeping whatever the sheet
        # used to distinguish this particular follow-up ("type", "primary
        # reason for taking birth control pills", "when start", "duration
        # of use", ...).
        distinguishing = re.sub(
            r"^\s*if\s+yes\s*,?\s*", "", raw_followup_header, flags=re.IGNORECASE
        ).strip()
        distinguishing = re.sub(r"\s*:\s*$", "", distinguishing).strip()

        if not distinguishing:
            # A bare "If yes" with nothing else to go on -- fall back to
            # the old generic "type" wording rather than producing an
            # empty label.
            distinguishing = "type item"
        elif not re.search(r"\bitem\b", distinguishing, re.IGNORECASE):
            distinguishing = f"{distinguishing} item"

    return f'{distinguishing} (if yes, for "{base_name}")'


def _process_followup_columns(header: "list[str]", data_rows: "list[list[str]]"):
    """
    Finds "if yes, type item"-style follow-up columns -- identified
    positionally (immediately following a non-follow-up column) rather than
    by exact header text, since the real sheet reuses this same literal
    header for many different items -- and for each one:
      - Renames it to reference the item it follows (see
        _build_followup_label()).
      - Blanks its value for any row where the preceding item's value isn't
        "Yes", instead of showing whatever raw text (often "No") was left in
        that cell.
    Operates on plain Python lists rather than a DataFrame/dict so it works
    correctly even when several columns share the exact same literal header
    text (a dict- or column-name-keyed approach would silently collide).
    """
    header = list(header)
    data_rows = [list(row) for row in data_rows]
    last_base_idx = None
    for i, col in enumerate(header):
        if FOLLOWUP_HEADER_RE.match(col or ""):
            if last_base_idx is not None:
                base_name = header[last_base_idx]
                header[i] = _build_followup_label(base_name, col)
                for row in data_rows:
                    if len(row) > max(i, last_base_idx) and not _is_yes(row[last_base_idx]):
                        row[i] = ""
            # else: a follow-up column with no recognizable item before it
            # (e.g. it's the very first column) -- leave it untouched rather
            # than guessing what it belongs to.
        else:
            last_base_idx = i
    return header, data_rows


def _add_resolved_location_column(header: "list[str]", data_rows: "list[list[str]]"):
    """
    Appends RESOLVED_LOCATION_COLUMN to `header`/`data_rows`, computed per
    row from SUBJECT_POPULATION_LOCATION_COLUMN and PI_LOCATION_COLUMN via
    resolve_participant_location() (see participant_location.py for the
    resolution rules). Runs positionally, before the two raw source columns
    get dropped via EXCLUDED_COLUMNS, so this is the only place that ever
    needs to read their raw values.
    """
    try:
        spl_idx = header.index(SUBJECT_POPULATION_LOCATION_COLUMN)
    except ValueError:
        spl_idx = None
    try:
        pi_idx = header.index(PI_LOCATION_COLUMN)
    except ValueError:
        pi_idx = None

    if spl_idx is None and pi_idx is None:
        _warn(
            f"Could not find either '{SUBJECT_POPULATION_LOCATION_COLUMN}' or "
            f"'{PI_LOCATION_COLUMN}' in '{COMPLETE_DATASETS_TAB}' -- "
            f"'{RESOLVED_LOCATION_COLUMN}' will be blank and no cohorts will "
            f"be placed on the map. Columns found: {header}"
        )
        return header + [RESOLVED_LOCATION_COLUMN], [list(r) + [""] for r in data_rows]

    if spl_idx is None:
        _warn(
            f"Could not find '{SUBJECT_POPULATION_LOCATION_COLUMN}' in "
            f"'{COMPLETE_DATASETS_TAB}' -- falling back to only "
            f"'{PI_LOCATION_COLUMN}' for every cohort's map location."
        )
    if pi_idx is None:
        _warn(
            f"Could not find '{PI_LOCATION_COLUMN}' in "
            f"'{COMPLETE_DATASETS_TAB}' -- cohorts whose "
            f"'{SUBJECT_POPULATION_LOCATION_COLUMN}' is blank, "
            f"'Nationwide', or lists multiple locations won't have a "
            f"fallback and will be left unplaced on the map."
        )

    cohort_idx = header.index(COHORT_NAME_COLUMN) if COHORT_NAME_COLUMN in header else None

    new_header = header + [RESOLVED_LOCATION_COLUMN]
    new_rows = []
    unresolved_cohorts = []
    for row in data_rows:
        spl_value = row[spl_idx] if spl_idx is not None and len(row) > spl_idx else ""
        pi_value = row[pi_idx] if pi_idx is not None and len(row) > pi_idx else ""
        resolved, _source = resolve_participant_location(spl_value, pi_value)
        new_rows.append(list(row) + [resolved or ""])
        if not resolved and (str(spl_value).strip() or str(pi_value).strip()):
            name = row[cohort_idx] if cohort_idx is not None and len(row) > cohort_idx else "(unknown cohort)"
            unresolved_cohorts.append(name)

    if unresolved_cohorts:
        _warn(
            f"Could not resolve a state/region/country for "
            f"{len(unresolved_cohorts)} cohort(s) from their "
            f"'{SUBJECT_POPULATION_LOCATION_COLUMN}'/'{PI_LOCATION_COLUMN}' "
            f"values -- they'll be left unplaced on the map: "
            f"{unresolved_cohorts}. Consider adding the missing city/state/"
            f"country to state_centroids.py or country_centroids.py."
        )

    return new_header, new_rows


def get_complete_datasets(gc) -> pd.DataFrame:
    """
    Fetches the 'Complete Datasets' tab: one row per cohort, one column per
    variable (cohort characteristics + ~90 women's-health item columns).

    Reads raw values (like get_table() does for the "Table" tab) rather than
    gspread's dict-based get_all_records(), specifically so that duplicate
    header text -- e.g. several different "if yes, type item" follow-up
    columns -- can't silently collide and lose data before this script ever
    sees it. Column names are de-duplicated/renamed by
    _process_followup_columns() below using column position, then blank-
    header and explicitly-excluded columns (see EXCLUDED_COLUMNS) are
    dropped entirely so they never show up anywhere in the dashboard.
    """
    if gc is None:
        _warn(
            f"No Sheets API credentials configured (GOOGLE_CREDENTIALS "
            f"and/or SPREADSHEET_ID are empty) -- using MOCK "
            f"'{COMPLETE_DATASETS_TAB}' data instead of your real sheet. "
            f"Check that both are set as repo secrets and spelled exactly "
            f"right in Settings -> Secrets and variables -> Actions."
        )
        return _mock_complete_datasets()

    ws = gc.open_by_key(SPREADSHEET_ID).worksheet(COMPLETE_DATASETS_TAB)
    raw_rows = ws.get_all_values()

    # Skip any fully-blank leading row(s) above the real header, same as
    # get_table() does for the "Table" tab.
    first_nonblank = next(
        (i for i, r in enumerate(raw_rows) if any(str(c).strip() for c in r)),
        None,
    )
    skipped = first_nonblank or 0
    rows = raw_rows[skipped:]
    if skipped:
        _warn(
            f"Skipped {skipped} blank row(s) at the top of the "
            f"'{COMPLETE_DATASETS_TAB}' tab before its header."
        )

    if not rows:
        raise ValueError(f"'{COMPLETE_DATASETS_TAB}' tab appears to be empty.")

    header, *data_rows = rows
    header = [h.strip() for h in header]
    header = _rename_sex_composition_column(header)
    header = _standardize_headers(header)

    # get_all_values() can return short rows when a row's trailing cells are
    # blank -- pad/truncate every row to the header's width so positional
    # indexing below is always safe.
    width = len(header)
    data_rows = [(list(r) + [""] * width)[:width] for r in data_rows]

    header, data_rows = _process_followup_columns(header, data_rows)
    header, data_rows = _add_resolved_location_column(header, data_rows)

    excluded = {c.strip().lower() for c in EXCLUDED_COLUMNS}
    keep_idx = [i for i, h in enumerate(header) if h.strip() and h.strip().lower() not in excluded]
    dropped_blank = sum(1 for h in header if not h.strip())
    if dropped_blank:
        _warn(
            f"Dropped {dropped_blank} blank-header column(s) from "
            f"'{COMPLETE_DATASETS_TAB}'."
        )
    header = [header[i] for i in keep_idx]
    data_rows = [[row[i] for i in keep_idx] for row in data_rows]
    header = _dedupe_columns(header)

    df = pd.DataFrame(data_rows, columns=header)
    # Drop fully-empty trailing rows, if any.
    df = df[df.apply(lambda r: any(str(v).strip() for v in r), axis=1)]
    return df.reset_index(drop=True)


def get_table(gc) -> pd.DataFrame:
    """
    Fetches the 'Table' tab, which has a two-row header: a top-level group
    ("Classification Validity" / "Temporal Validity", merged across two
    columns each) and a sub-header row underneath ("Procedure Separation
    Type", "Other Factors", "Collection Design", "Follow-up Interval").
    Flattens that into single column names like
    "Classification Validity - Procedure Separation Type".
    """
    if gc is None:
        _warn(
            f"No Sheets API credentials configured (GOOGLE_CREDENTIALS "
            f"and/or SPREADSHEET_ID are empty) -- using MOCK "
            f"'{TABLE_TAB}' data instead of your real sheet. Check that "
            f"both are set as repo secrets and spelled exactly right in "
            f"Settings -> Secrets and variables -> Actions."
        )
        return _mock_table()

    ws = gc.open_by_key(SPREADSHEET_ID).worksheet(TABLE_TAB)
    raw_rows = ws.get_all_values()

    # Google Sheets tabs often have a blank spacer row (or a title row) above
    # the real header -- skip any fully-blank leading rows so the two-row
    # header logic below always sees the actual header first, regardless of
    # how the tab happens to be laid out visually.
    first_nonblank = next(
        (i for i, r in enumerate(raw_rows) if any(str(c).strip() for c in r)),
        None,
    )
    skipped = first_nonblank or 0
    rows = raw_rows[skipped:]
    if skipped:
        _warn(
            f"Skipped {skipped} blank row(s) at the top of the '{TABLE_TAB}' "
            f"tab before its header."
        )

    df = _parse_two_row_header_table(rows)

    if TABLE_COHORT_COLUMN not in df.columns:
        # Don't let this fail with a bare pandas KeyError several steps
        # later -- show exactly what the real sheet's header rows look
        # like so a mismatch (different wording, an extra header row, a
        # merged cell that isn't blank where we expect it, etc.) can be
        # diagnosed from the Actions log directly instead of guessing.
        raise ValueError(
            f"Could not find a '{TABLE_COHORT_COLUMN}' column in '{TABLE_TAB}' "
            f"after flattening its two-row header. This means the tab's header "
            f"layout doesn't match what this script expects (a blank cell above "
            f"the cohort-name column, then merged group headers like "
            f"'Classification Validity' spanning the columns after it).\n"
            f"Skipped {skipped} leading blank row(s).\n"
            f"Raw header row 1 (group headers): {rows[0] if len(rows) > 0 else '(missing)'}\n"
            f"Raw header row 2 (sub-headers): {rows[1] if len(rows) > 1 else '(missing)'}\n"
            f"Raw header row 3 (in case there's a 3rd header row): "
            f"{rows[2] if len(rows) > 2 else '(missing)'}\n"
            f"Columns produced after flattening: {list(df.columns)}"
        )

    return df


def _parse_two_row_header_table(rows: "list[list[str]]") -> pd.DataFrame:
    """
    Shared parsing logic for a sheet with a merged top-level header row
    followed by a sub-header row, pulled out so it can be unit tested
    without a live API call.
    """
    if len(rows) < 3:
        raise ValueError(
            f"Expected at least 2 header rows + 1 data row in '{TABLE_TAB}', "
            f"got {len(rows)} rows total."
        )

    top_header, sub_header, *data_rows = rows

    # Stop at the first fully-blank row after the header, rather than
    # scanning every remaining row in the tab. Sheets in this lab commonly
    # have a color-coding legend/notes section a row or two below the real
    # table (e.g. explaining what "Procedure Separation Type" levels 1-5
    # mean) -- without this, that legend's rows get parsed as if they were
    # more cohorts, showing up downstream as bogus "cohort(s) with no
    # matching row" warnings (e.g. "type 1".."type 5").
    first_blank = next(
        (i for i, r in enumerate(data_rows) if not any(str(c).strip() for c in r)),
        None,
    )
    if first_blank is not None and first_blank < len(data_rows):
        ignored = len(data_rows) - first_blank
        if ignored:
            _warn(
                f"Ignoring {ignored} row(s) in '{TABLE_TAB}' after a blank "
                f"separator row (assumed to be a legend/notes section below "
                f"the real table, not more cohorts)."
            )
        data_rows = data_rows[:first_blank]

    # Merged cells come back from the API as the value in the first cell and
    # "" in the cells they span, so forward-fill left-to-right to
    # reconstruct which group each sub-header belongs to.
    filled_top = []
    last = ""
    for cell in top_header:
        if cell.strip():
            last = cell.strip()
        filled_top.append(last)

    columns = []
    for top, sub in zip(filled_top, sub_header):
        sub = sub.strip()
        if not sub or sub == top:
            columns.append(top)
        elif not top:
            # No merged group header above this column (e.g. the leading
            # "Cohort" identifier column, which sits to the left of the
            # "Classification Validity"/"Temporal Validity" merged
            # headers) -- use the sub-header on its own instead of
            # producing a stray " - Cohort".
            columns.append(sub)
        else:
            columns.append(f"{top} - {sub}")

    columns = _dedupe_columns(columns)

    # A stray blank spacer column in the sheet (blank in both header rows,
    # e.g. for visual spacing next to the "Cohort" column) flattens to an
    # empty-string column name here -- which then survives all the way to
    # the cohort detail modal as an unlabeled row showing just an em dash
    # (see renderDetailSection() in dashboard.js / DD.formatValue()).
    # Dropped here, with a warning, rather than downstream, since an empty
    # header can never be a real "Classification Validity"/"Temporal
    # Validity" column.
    keep_idx = [i for i, c in enumerate(columns) if c.strip()]
    if len(keep_idx) != len(columns):
        _warn(
            f"Dropped {len(columns) - len(keep_idx)} column(s) with a blank "
            f"flattened header from '{TABLE_TAB}' (likely stray spacer "
            f"column(s) in the sheet, between the cohort-name column and "
            f"the merged group headers)."
        )
        columns = [columns[i] for i in keep_idx]
        data_rows = [[row[i] for i in keep_idx] for row in data_rows]

    df = pd.DataFrame(data_rows, columns=columns)
    # Drop fully-empty trailing rows, if any
    df = df[df.apply(lambda r: any(str(v).strip() for v in r), axis=1)]
    return df.reset_index(drop=True)


def _normalize_cohort_name(name) -> str:
    if name is None or (isinstance(name, float) and math.isnan(name)):
        return ""
    return re.sub(r"\s+", " ", str(name).strip().lower())


def _is_excluded_cohort(name) -> bool:
    """
    Whether `name` matches an entry in EXCLUDED_COHORTS (see above) as a
    whole word anywhere in the (whitespace-/case-normalized) cohort name --
    not just a prefix -- so both "RANN (Columbia PI Stern)" and "Reference
    Ability Neural Network (RANN)" match a listed "RANN" entry.
    """
    normalized = _normalize_cohort_name(name)
    if not normalized:
        return False
    for excluded in EXCLUDED_COHORTS:
        excluded_normalized = _normalize_cohort_name(excluded)
        if excluded_normalized and re.search(
            r"\b" + re.escape(excluded_normalized) + r"\b", normalized
        ):
            return True
    return False


def _drop_excluded_cohorts(df: pd.DataFrame, name_column: str, source_label: str) -> pd.DataFrame:
    """
    Drops any row whose `name_column` matches EXCLUDED_COHORTS -- applied to
    both tabs right after fetching, before they're joined/geocoded in
    build_cohorts(), so an excluded cohort never appears in
    complete_datasets.json, table.json, or cohorts.json.
    """
    if name_column not in df.columns:
        return df
    mask = df[name_column].map(_is_excluded_cohort)
    if mask.any():
        _warn(
            f"Excluded {int(mask.sum())} cohort row(s) from '{source_label}' "
            f"per EXCLUDED_COHORTS: {df.loc[mask, name_column].tolist()}."
        )
    return df.loc[~mask].reset_index(drop=True)


def _geocode_resolved_location(value):
    """
    Geocodes a RESOLVED_LOCATION_COLUMN value, which is either a U.S.
    state/territory name or a country name (see participant_location.py).
    Tries the state/territory lookup first since most cohorts in this
    dataset are U.S.-based, then falls back to the country lookup.
    """
    value = str(value).strip() if value is not None else ""
    if not value:
        return None
    return geocode_state(value) or geocode_country(value)


def build_cohorts(complete_df: pd.DataFrame, table_df: pd.DataFrame) -> pd.DataFrame:
    """
    Joins the two tabs on cohort name and geocodes each cohort's
    RESOLVED_LOCATION_COLUMN (the cleaned-up state/region/country derived
    from "Subject population location", falling back to the PI/study
    location column -- see participant_location.py) to an approximate
    lat/lon centroid.

    Cohorts sharing a location intentionally get the exact same Latitude/
    Longitude here -- separating overlapping markers is handled client-side
    (see renderMapMarkers() in charts/dashboard.js), which spaces them apart
    in *screen-pixel* space and recomputes on every zoom change. A static,
    degrees-based offset computed once here would look right at one zoom
    level and collapse back into an overlapping blob at any other (map
    degrees-per-pixel shrinks a lot when zoomed out), which is exactly the
    overlap this used to produce at the default whole-world view.
    """
    complete_df = complete_df.copy()
    table_df = table_df.copy()

    complete_df["_join_key"] = complete_df[COHORT_NAME_COLUMN].map(_normalize_cohort_name)
    table_df["_join_key"] = table_df[TABLE_COHORT_COLUMN].map(_normalize_cohort_name)

    unmatched_complete = set(complete_df["_join_key"]) - set(table_df["_join_key"])
    unmatched_table = set(table_df["_join_key"]) - set(complete_df["_join_key"])
    if unmatched_complete:
        _warn(
            f"{len(unmatched_complete)} cohort(s) in "
            f"'{COMPLETE_DATASETS_TAB}' have no matching row in '{TABLE_TAB}' "
            f"(validity fields will be blank for them): {sorted(unmatched_complete)}. "
            f"This usually means the 'Cohort Name' / 'Cohort' spelling differs "
            f"slightly between the two tabs."
        )
    if unmatched_table:
        _warn(
            f"{len(unmatched_table)} cohort(s) in '{TABLE_TAB}' have "
            f"no matching row in '{COMPLETE_DATASETS_TAB}' (dropped from "
            f"cohorts.json): {sorted(unmatched_table)}. This usually means "
            f"the 'Cohort Name' / 'Cohort' spelling differs slightly between "
            f"the two tabs."
        )

    merged = complete_df.merge(
        table_df.drop(columns=[TABLE_COHORT_COLUMN]),
        on="_join_key",
        how="left",
    ).drop(columns=["_join_key"])

    coords = merged[RESOLVED_LOCATION_COLUMN].map(_geocode_resolved_location)
    merged["Latitude"] = coords.map(lambda c: c[0] if c else None)
    merged["Longitude"] = coords.map(lambda c: c[1] if c else None)

    missing_geo = (
        merged.loc[merged["Latitude"].isna(), RESOLVED_LOCATION_COLUMN]
        .map(lambda v: str(v).strip())
        .loc[lambda s: s != ""]
        .unique()
        .tolist()
    )
    if missing_geo:
        _warn(
            f"Could not geocode these resolved '{RESOLVED_LOCATION_COLUMN}' "
            f"value(s) -- those cohorts will be omitted from the map: "
            f"{missing_geo}. Add them to state_centroids.py or "
            f"country_centroids.py."
        )

    return merged


# Hardcoded header -> child-columns groupings for the Coverage Checklist
# (Table 2) matrix table, using the final standardized column names (post
# HEADER_STANDARDIZATION_MAP) -- so the front end can visually distinguish
# a section-header row from its sub-items and cascade a header checkbox's
# check/uncheck to all of its children (see renderTable2()/the checklist
# picker in charts/dashboard.js).
#
# This is a fixed, hand-built list rather than something inferred at
# runtime (e.g. from indentation or naming patterns) because the real
# sheet's column order/wording doesn't reliably signal "this one's a
# section header" any other way. Built from -- and double-checked against
# -- the "Column Audit" sheet's decision column (the "Red rows" in that
# sheet's Legend are explicitly the section/category-heading candidates).
#
# A group's "children" list can contain either:
#   - a leaf column-name string (an actual per-cohort checklist item), or
#   - another nested {"header": ..., "children": [...]} dict, for headers
#     that are themselves a sub-section of a larger umbrella header.
#
# Per the audit sheet, "Menopause-related symptom items" is the umbrella
# header over all 7 symptom sub-groups below (each renamed via
# HEADER_STANDARDIZATION_MAP above to "<Category> symptom items"), and
# "Menstrual cycle / bleeding pattern item" is a separate, single-level
# section header that was missing from the previous version of this list.
CHECKLIST_SECTION_GROUPS = [
    {
        "header": "Menstrual cycle / bleeding pattern item",
        "children": [
            "Cycle regularity item",
            "Cycle length in days item",
            "Change in cycle length item",
            "Skipped cycles item",
            "Bleeding flow / amount item",
            "Time since last period item",
            "Length of time without a period (amenorrhea) item",
        ],
    },
    {
        "header": "Menopause-related symptom items",
        "children": [
            {
                "header": "Vasomotor symptom items",
                "children": ["Hot flashes item", "Night sweats item"],
            },
            {
                "header": "Sleep symptom items",
                "children": [
                    "Difficulty getting to sleep item",
                    "Difficulty staying asleep item",
                    "Nighttime awakening item",
                ],
            },
            {
                "header": "Somatic symptom items",
                "children": [
                    "Heart palpitations item",
                    "Skin itching item",
                    "Headaches item",
                    "Bloated stomach item",
                    "Breast tenderness item",
                    "Joint pains item",
                ],
            },
            {
                "header": "Mood symptom items",
                "children": [
                    "Tiredness item",
                    "Irritability item",
                    "Feeling anxious item",
                    "Feeling depressed item",
                    "Mood swings item",
                    "Crying spells item",
                ],
            },
            {
                "header": "Cognitive symptom items",
                "children": ["Difficulty concentrating item", "Poor memory item"],
            },
            {
                "header": "Genitourinary symptom items",
                "children": [
                    "Frequent urination item",
                    "Urine leakage item",
                    "Painful urination item",
                    "Bladder infection item",
                    "Stool or gas item",
                    "Dry vagina item",
                    "Vaginal itching item",
                    "Abnormal vaginal discharge item",
                    "Vaginal infection item",
                    "Pain during intercourse item",
                    "Pain inside vagina during intercourse item",
                    "Bleeding after intercourse item",
                ],
            },
            {
                "header": "Sexual/libido symptom items",
                "children": [
                    "Lack of sexual desire item",
                    "Orgasm difficulty item",
                    "Limited sexual opportunity item",
                ],
            },
        ],
    },
]


def build_schema(complete_df: pd.DataFrame, table_df: pd.DataFrame, is_mock_data: bool = False) -> dict:
    """
    Describes which columns are which, so the dashboard front-end doesn't
    need to hardcode ~90 checklist column names.

    `is_mock_data` is threaded through to the front-end so it can show a
    banner when the site is running on the small placeholder dataset instead
    of the real spreadsheet (e.g. because GOOGLE_CREDENTIALS / SPREADSHEET_ID
    aren't reaching the build) -- previously this was only detectable by
    eyeballing the cohort names against the mock data by hand.
    """
    metadata_columns = [c for c in METADATA_COLUMNS if c in complete_df.columns]
    checklist_columns = [
        c for c in complete_df.columns if c not in METADATA_COLUMNS
    ]
    validity_columns = [c for c in table_df.columns if c != TABLE_COHORT_COLUMN]

    # Only include a group (and only the children that are actually present)
    # if its header column made it into this dataset -- keeps the mock
    # dataset (which doesn't have most of these real columns) from ending
    # up with a bunch of empty/dangling groups. Recursive because
    # CHECKLIST_SECTION_GROUPS can nest a group inside another group's
    # "children" (e.g. "Vasomotor symptom items" nested inside
    # "Menopause-related symptom items") -- see CHECKLIST_SECTION_GROUPS.
    def _filter_checklist_group(group, present_columns):
        if group["header"] not in present_columns:
            return None
        filtered_children = []
        for child in group["children"]:
            if isinstance(child, dict):
                filtered_child = _filter_checklist_group(child, present_columns)
                if filtered_child is not None:
                    filtered_children.append(filtered_child)
            elif child in present_columns:
                filtered_children.append(child)
        if not filtered_children:
            return None
        return {"header": group["header"], "children": filtered_children}

    checklist_groups = []
    for group in CHECKLIST_SECTION_GROUPS:
        filtered = _filter_checklist_group(group, checklist_columns)
        if filtered is not None:
            checklist_groups.append(filtered)

    return {
        "cohort_name_column": COHORT_NAME_COLUMN,
        "metadata_columns": metadata_columns,
        "checklist_columns": checklist_columns,
        "checklist_groups": checklist_groups,
        "validity_columns": validity_columns,
        "procedure_separation_type_column": next(
            (c for c in validity_columns if c.endswith("Procedure Separation Type")),
            None,
        ),
        "resolved_location_column": (
            RESOLVED_LOCATION_COLUMN if RESOLVED_LOCATION_COLUMN in complete_df.columns else None
        ),
        "is_mock_data": is_mock_data,
    }


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    have_credentials = bool(GOOGLE_CREDENTIALS and SPREADSHEET_ID)
    gc = _client() if have_credentials else None

    complete_datasets = get_complete_datasets(gc)
    table = get_table(gc)
    complete_datasets = _drop_excluded_cohorts(
        complete_datasets, COHORT_NAME_COLUMN, COMPLETE_DATASETS_TAB
    )
    table = _drop_excluded_cohorts(table, TABLE_COHORT_COLUMN, TABLE_TAB)
    cohorts = build_cohorts(complete_datasets, table)
    schema = build_schema(complete_datasets, table, is_mock_data=not have_credentials)

    complete_datasets.to_json(
        OUTPUT_DIR / "complete_datasets.json", orient="records", indent=2
    )
    table.to_json(OUTPUT_DIR / "table.json", orient="records", indent=2)
    cohorts.to_json(OUTPUT_DIR / "cohorts.json", orient="records", indent=2)
    with open(OUTPUT_DIR / "schema.json", "w") as f:
        json.dump(schema, f, indent=2)

    print(f"Wrote {len(complete_datasets)} rows to {OUTPUT_DIR / 'complete_datasets.json'}")
    print(f"Wrote {len(table)} rows to {OUTPUT_DIR / 'table.json'}")
    print(f"Wrote {len(cohorts)} rows to {OUTPUT_DIR / 'cohorts.json'}")
    print(f"Wrote schema to {OUTPUT_DIR / 'schema.json'}")


if __name__ == "__main__":
    main()
