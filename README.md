# The Women's Health Database -- Visualization Pipeline

Pulls cohort data from a private Google Sheet, exports it as JSON, and
publishes it to a public URL via GitHub Pages. Embed that URL in the lab's
WordPress site with an iframe, and it will show whatever was published on
the most recent run. Updates are **manual only** -- nothing runs on a
timer. To publish fresh data, go to **Actions -> "Update Data and Deploy to
Pages" -> Run workflow** whenever the spreadsheet has changes you want to
go live.

The source Google Sheet itself is **never made public**. Data is read via
an authenticated Google Sheets API call (a service account), not a
published/public link -- see "Connecting the Google Sheet" below.

## One-time setup (do this once per repo)

1. Create a new GitHub repo and push these files to the `main` branch,
   keeping the folder structure exactly as-is (the `.github/workflows/`
   path matters -- GitHub only detects Actions there).

2. In the repo, go to **Settings -> Pages**.
   Under "Build and deployment", set **Source** to **GitHub Actions**
   (not "Deploy from a branch"). This lets our workflow control the
   Pages deployment directly.

3. Go to **Settings -> Actions -> General -> Workflow permissions** and
   make sure **"Read and write permissions"** is selected. This lets the
   Action commit the refreshed data back to the repo.

4. Connect the Google Sheet (see next section), then manually run the
   workflow once to confirm everything works:
   **Actions tab -> "Update Data and Deploy to Pages" -> Run workflow**.

5. After it finishes, go back to **Settings -> Pages** -- GitHub will show
   your live URL, something like:

   `https://<your-github-username-or-org>.github.io/<repo-name>/`

## Connecting the Google Sheet

Data comes from two tabs -- **Complete Datasets** and **Table** -- read
live on every run via the Google Sheets API using a service account. The
sheet is shared only with that service account's email address, the same
way you'd share it with a person; it's never published to the open web.
The repo never stores a copy of the raw sheet -- edit it, then manually
trigger the workflow (**Actions -> "Update Data and Deploy to Pages" ->
Run workflow**) whenever you want that change to go live.

**One-time Google Cloud setup (~10-15 minutes):**

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a new project (or use an existing one). No billing account is
   required for Sheets API read access.
2. **APIs & Services -> Library**, search for "Google Sheets API", and
   click **Enable**.
3. **APIs & Services -> Credentials -> Create Credentials -> Service
   account**. Give it any name (e.g. "lifecoglab-sheet-reader"). You don't
   need to grant it any IAM roles -- it gets access to the sheet through
   sharing, not through Cloud IAM. Click through to **Done**.
4. Click into the new service account -> **Keys** tab -> **Add Key ->
   Create new key -> JSON**. This downloads a `.json` credentials file --
   keep it private, it's the actual credential.
5. Open that JSON file and copy the `client_email` value (looks like
   `something@your-project.iam.gserviceaccount.com`).
6. Open the actual Google Sheet, click **Share**, and share it with that
   email address as a **Viewer**.

**Wire the credentials into the workflow:**

1. In the GitHub repo, go to **Settings -> Secrets and variables ->
   Actions -> Secrets tab -> New repository secret**.
2. Name: `GOOGLE_CREDENTIALS`. Value: paste the **entire contents** of the
   downloaded JSON key file.
3. Get the Sheet's ID from its URL:
   `https://docs.google.com/spreadsheets/d/<THIS PART>/edit`.
4. Still on the **Secrets tab -> New repository secret**. Name:
   `SPREADSHEET_ID`. Value: the ID from step 3. (This isn't sensitive on
   its own -- it's useless without the credential above -- but it's stored
   as a Secret here too rather than a plain Variable.)
5. Save both. The workflow already references
   `${{ secrets.GOOGLE_CREDENTIALS }}` and `${{ secrets.SPREADSHEET_ID }}`
   and passes them to `fetch_data.py` as environment variables -- no other
   changes needed.

**Sheet shape:** `fetch_data.py` expects tabs named exactly `Complete
Datasets` and `Table`, with `Table` having a two-row header (a merged
top-level group row -- "Classification Validity" / "Temporal Validity" --
followed by a sub-header row). If your tab names or header layout differ,
update the constants/parsing at the top of `fetch_data.py`.

**Local testing:** if you run `python fetch_data.py` locally without
`GOOGLE_CREDENTIALS` / `SPREADSHEET_ID` set, it falls back to small mock
datasets shaped like the real tabs, so the script and downstream dashboard
code stay testable before the Google Cloud setup is done. To test against
the real sheet locally:

```bash
export GOOGLE_CREDENTIALS="$(cat /path/to/downloaded-key.json)"
export SPREADSHEET_ID="your-sheet-id-from-the-url"
python fetch_data.py
```

This writes `charts/data/complete_datasets.json` and
`charts/data/table.json`.

## Embedding in WordPress

Have the lab member with `wp-admin` access add a **Custom HTML block**
(or WPBakery "Raw HTML" element) to the page, with:

```html
<iframe
  src="https://<your-github-username-or-org>.github.io/<repo-name>/"
  width="100%"
  height="550"
  style="border:none;"
  title="The Women's Health Database">
</iframe>
```

This only needs to be done once. The WordPress page always shows whatever
was published by the most recent manual run of the Action -- see "Editing
the data source" below for how to trigger one.

## Editing the data source

- Data-fetching logic lives in `fetch_data.py` -- `get_complete_datasets()`
  and `get_table()` read the two tabs via the Sheets API and write JSON
  into `charts/data/`.
- If a future data source needs additional credentials, add them as repo
  **Secrets** the same way as `GOOGLE_CREDENTIALS` (**Settings -> Secrets
  and variables -> Actions -> Secrets tab**), and reference them in the
  workflow as `${{ secrets.YOUR_SECRET_NAME }}`.
- Updates are manual only -- run **Actions -> "Update Data and Deploy to
  Pages" -> Run workflow** whenever you want to publish the latest
  spreadsheet data. (Pushing a code change to `fetch_data.py`, the chart
  files, etc. also triggers a run automatically, since that's when you'd
  want the live site rebuilt anyway.) If you ever want a scheduled
  refresh again, add a `schedule:` trigger back into the `on:` block in
  `.github/workflows/update-chart.yml`.
- The dashboard front-end lives in `charts/index.html` (shell + tab nav),
  `charts/dashboard.css` (styling), `charts/dashboard-data.js` (pure
  filtering/classification/coloring logic, unit-testable in Node), and
  `charts/dashboard.js` (DOM rendering + Leaflet map). It reads
  `charts/data/cohorts.json` and `charts/data/schema.json` at load time and
  renders four tabs: a sortable **Cohort Summary** table, a color-coded
  **Coverage Checklist** matrix (with searchable cohort/column pickers), a
  **Custom Filter** AND/OR condition builder, and an interactive **Map**
  (Leaflet, via CDN) with cohorts geocoded by country (see
  `country_centroids.py`), jittered apart when they share a country, sized
  by N, colored by Procedure Separation Type, and clickable for the full
  record.

## Collaboration

Anyone in the lab can clone this repo, edit `fetch_data.py`, and open a
pull request -- no server access or WordPress login needed to contribute
to the data/visualization code itself. Note that contributors will need
their own read access to the Google Sheet (or to test against the mock
data) since the sheet credential itself is a private secret, not checked
into the repo.
