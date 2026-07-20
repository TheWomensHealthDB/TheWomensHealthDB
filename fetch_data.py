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
METADATA_COLUMNS = [
    "Cohort Name",
    "Location",
    "Public Availability",
    "N",
    "Age Range",
    "%male/%female",
    "Year Started/Wave Description",
    "Wording of Related Questions/Variables",
]

COHORT_NAME_COLUMN = "Cohort Name"
TABLE_COHORT_COLUMN = "Cohort"


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
            "Location": "United States",
            "Public Availability": "Yes",
            "N": 1200,
            "Age Range": "40-60",
            "%male/%female": "0/100",
            "Year Started/Wave Description": "Wave 1: 2005",
            "Hysterectomy Question Included": "Yes",
            "Oopherectomy Question Included": "No",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "To some extent",
            "Hot flashes item:": "Yes",
            "Night sweats item:": "To some extent",
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
            "Location": "United Kingdom",
            "Public Availability": "No",
            "N": 850,
            "Age Range": "35-55",
            "%male/%female": "0/100",
            "Year Started/Wave Description": "Wave 1: 1998",
            "Hysterectomy Question Included": "No",
            "Oopherectomy Question Included": "No",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "No",
            "Hot flashes item:": "No",
            "Night sweats item:": "No",
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
            "Location": "United States",
            "Public Availability": "Yes",
            "N": 3400,
            "Age Range": "18-45",
            "%male/%female": "45/55",
            "Year Started/Wave Description": "Wave 1: 2012",
            "Hysterectomy Question Included": "Yes",
            "Oopherectomy Question Included": "Yes",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "Yes",
            "Hot flashes item:": "To some extent",
            "Night sweats item:": "No",
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
            "Location": "United Kingdom",
            "Public Availability": "Yes",
            "N": 2100,
            "Age Range": "50-70",
            "%male/%female": "0/100",
            "Year Started/Wave Description": "Wave 1: 2001",
            "Hysterectomy Question Included": "Yes",
            "Oopherectomy Question Included": "To some extent",
            "Pregnancy Question Included": "No",
            "PCOS/PMOS Item": "No",
            "Hot flashes item:": "Yes",
            "Night sweats item:": "Yes",
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
            "Location": "Canada",
            "Public Availability": "No",
            "N": 640,
            "Age Range": "45-65",
            "%male/%female": "0/100",
            "Year Started/Wave Description": "Wave 1: 2010",
            "Hysterectomy Question Included": "Yes",
            "Oopherectomy Question Included": "Yes",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "No",
            "Hot flashes item:": "Yes",
            "Night sweats item:": "Yes",
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
            "Location": "Australia",
            "Public Availability": "Yes",
            "N": 980,
            "Age Range": "40-55",
            "%male/%female": "0/100",
            "Year Started/Wave Description": "Wave 1: 2009",
            "Hysterectomy Question Included": "No",
            "Oopherectomy Question Included": "No",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "To some extent",
            "Hot flashes item:": "No",
            "Night sweats item:": "No",
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
            "Location": "Netherlands",
            "Public Availability": "Yes",
            "N": 1750,
            "Age Range": "30-50",
            "%male/%female": "50/50",
            "Year Started/Wave Description": "Wave 1: 2015",
            "Hysterectomy Question Included": "Yes",
            "Oopherectomy Question Included": "No",
            "Pregnancy Question Included": "Yes",
            "PCOS/PMOS Item": "Yes",
            "Hot flashes item:": "Yes",
            "Night sweats item:": "To some extent",
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
            "Location": "Japan",
            "Public Availability": "No",
            "N": 510,
            "Age Range": "42-58",
            "%male/%female": "0/100",
            "Year Started/Wave Description": "Wave 1: 2007",
            "Hysterectomy Question Included": "No",
            "Oopherectomy Question Included": "No",
            "Pregnancy Question Included": "No",
            "PCOS/PMOS Item": "No",
            "Hot flashes item:": "Yes",
            "Night sweats item:": "No",
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


def get_complete_datasets(gc) -> pd.DataFrame:
    """
    Fetches the 'Complete Datasets' tab: one row per cohort, one column per
    variable (cohort characteristics + ~90 women's-health item columns).
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
    records = ws.get_all_records()
    return pd.DataFrame(records)


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
    rows = ws.get_all_values()
    return _parse_two_row_header_table(rows)


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

    df = pd.DataFrame(data_rows, columns=columns)
    # Drop fully-empty trailing rows, if any
    df = df[df.apply(lambda r: any(str(v).strip() for v in r), axis=1)]
    return df.reset_index(drop=True)


def _normalize_cohort_name(name) -> str:
    if name is None or (isinstance(name, float) and math.isnan(name)):
        return ""
    return re.sub(r"\s+", " ", str(name).strip().lower())


def build_cohorts(complete_df: pd.DataFrame, table_df: pd.DataFrame) -> pd.DataFrame:
    """
    Joins the two tabs on cohort name and geocodes each cohort's
    country-level Location to an approximate lat/lon centroid.

    Cohorts sharing a country intentionally get the exact same Latitude/
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

    coords = merged["Location"].map(geocode_country)
    merged["Latitude"] = coords.map(lambda c: c[0] if c else None)
    merged["Longitude"] = coords.map(lambda c: c[1] if c else None)

    missing_geo = (
        merged.loc[merged["Latitude"].isna(), "Location"].dropna().unique().tolist()
    )
    if missing_geo:
        _warn(
            "Could not geocode these Location value(s) -- those "
            f"cohorts will be omitted from the map: {missing_geo}. Add them "
            "to country_centroids.py."
        )

    return merged


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

    return {
        "cohort_name_column": COHORT_NAME_COLUMN,
        "metadata_columns": metadata_columns,
        "checklist_columns": checklist_columns,
        "validity_columns": validity_columns,
        "procedure_separation_type_column": next(
            (c for c in validity_columns if c.endswith("Procedure Separation Type")),
            None,
        ),
        "is_mock_data": is_mock_data,
    }


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    have_credentials = bool(GOOGLE_CREDENTIALS and SPREADSHEET_ID)
    gc = _client() if have_credentials else None

    complete_datasets = get_complete_datasets(gc)
    table = get_table(gc)
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
