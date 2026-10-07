# Design: Team Mer master data column + filter

**Date:** 2026-10-07
**Project:** PPS·ACS·WISDOM Validator Dashboard (`DashBoard/`)
**Status:** Approved design (settled conversationally) — ready for implementation planning

---

## Goal

Add a **Team Mer** column to the results table, grouped under a new **Master Data** header,
and a **Team Mer** filter in the results toolbar. Picking a team shows only the rows that belong
to that team, and the Team Mer column on each row shows which team that is.

A row's team comes from **who created its CBD** in WISDOM, looked up in a master file the
master data team maintains.

## Data sources

| Source | What it gives | Notes |
| ------ | ------------- | ----- |
| `dbo.VIEW_COSTSHEET_WISDOM`, column **`Create CBD by`** (confirmed against the live view 2026-10-07; first written here as "Created CBD by", which matched nothing) | The creator's ID, e.g. `dev_alice` | Already returned — `/get_costsheet_data` does `SELECT *`. |
| `DashBoard/Data/Master_MerDevTeam.xlsx`, `Sheet1` | Two columns: `MER_TEAM`, `MER_DEV` | 41 data rows, 6 teams today. Gitignored (`*.xlsx`) — never committed. |

`Created CBD by` values have the same form as `MER_DEV` (`dev_alice`). This has **nothing to do
with the dashboard login** — the login user is not involved in this feature at all.

**Not verified:** the MCP database account gets *Permission denied* on
`VIEW_COSTSHEET_WISDOM`, so the exact header spelling and value format were confirmed by the
user, not by a query. Header matching is alias-tolerant (see below) to absorb small spelling
differences.

### Master file facts (checked 2026-10-07)

> All developer IDs and team names in this spec, the plan and the tests are **placeholders**
> (`dev_alice`, `TEAM_A`, …). The repo is public — real IDs and team names stay in the
> gitignored `.xlsx` only.

- No blank cells.
- Several developers appear twice in the **same** team with different capitalisation; the
  case-insensitive lookup collapses them (32 distinct developers).
- **Two developers are in two teams each:**
  `dev_carol` → `TEAM_B` and `Team D (X)`;
  `dev_dave` → `TEAM_A` and `Team D (X)`.

## Decisions (agreed)

- **Team comes from the winning Costsheet row.** The same row that already supplies
  *Version* and *Cost Sheet No.* (size-matched, MAX(First Input Date)) supplies `Created CBD by`.
  No new matching logic.
- **Keep the master as `.xlsx`.** The backend reads it; no SQL table for now.
- **A developer in several teams belongs to all of them.** The row's Team Mer is a list.
  Filtering by any of those teams shows the row. The column shows them joined with `, `
  (e.g. `TEAM_B, Team D (X)`). Accepted side effect: if anyone later totals rows per team,
  these rows count once per team.
- **Lookup ignores case and surrounding spaces** on both sides.
- **Rows that can't be assigned are labelled, not blank**, so they can be filtered and fixed:

  | Situation | Team Mer shows |
  | --------- | -------------- |
  | No Costsheet row matched (or Costsheet not loaded) | `(No Costsheet)` |
  | Costsheet matched but `Created CBD by` is empty | `(Unassigned)` |
  | `Created CBD by` not found in the master file | `(Unassigned)` |
  | Master file could not be loaded | `(Unassigned)` + an error toast explaining why |

- **The filter is a plain dropdown** (exact pick, like Season/Factory), not a type-to-filter box.
  Options are built from the current results: real team names A→Z, then `(Unassigned)`, then
  `(No Costsheet)`. Empty = all teams.
- **Master Data group sits right after the `#` column**, before MSC_CODE, so the team is the first
  thing read on each row. It holds two columns: **Team Mer** and **Created CBD by**.
  It is shown whether or not Costsheet is loaded.
- **Clear Filters resets the team filter.** The search box also matches Team Mer and
  Created CBD by.
- **CSV export gains `Team_Mer` and `Created_CBD_By`** right after `Row`. Export behaviour is
  otherwise unchanged — it still exports **all** rows, not just the filtered ones.
- **The master is re-read on every Validate.** The backend caches it by file modified-time, so
  when the master data team replaces the file, the next Validate picks it up with no restart.

## Non-goals (YAGNI)

- No per-team totals in the Summary page.
- No editing the master from the UI.
- No SQL table for the master.
- No change to which Costsheet row wins, to any verdict, or to any FOB logic.
- No change to CSV exporting only filtered rows.

---

## Architecture

```
dbo.VIEW_COSTSHEET_WISDOM ──/get_costsheet_data (unchanged)──┐
                                                              ▼
                        costsheet.ts: winning row → createdByVal
                                                              │
Data/Master_MerDevTeam.xlsx                                   │
   └─ mer_team.py (load + mtime cache)                        │
        └─ GET /get_mer_team_master ──► api.fetchMerTeamMaster│
                                         │ (on Validate)      ▼
                                         └──► runComparison(..., master)
                                                 merTeam.ts: merTeamsFor()
                                                              ▼
                                CompRow { cCreatedBy, merTeams: string[] }
                                                              ▼
                ResultsToolbar (Team Mer ▼) · App filter · ResultsTable · csv.ts
```

## Backend

### New module `DashBoard/mer_team.py`

Kept out of `sql_backend.py` (already 493 lines; project limit is 500).

```python
def load_master(path: str) -> dict[str, list[str]]
```

- Opens the workbook read-only with `openpyxl`, active sheet.
- Row 1 is the header. Finds the `MER_TEAM` and `MER_DEV` columns by name (case-insensitive,
  trimmed) — column order does not matter. Missing either → `ValueError` naming the column.
- For every later row: trims both cells; skips the row if either is empty.
  Key = `MER_DEV` lowercased; value = sorted list of distinct `MER_TEAM` values.
- Result is cached per path by the file's modified time; an unchanged file is not re-read.

Path: env `MER_TEAM_MASTER_PATH`, default `<DashBoard>/Data/Master_MerDevTeam.xlsx`
(resolved relative to the module file, not the working directory).

### New route, registered from `mer_team.py`

`GET /get_mer_team_master` — `@login_required`. Defined in `mer_team.register_routes(app,
login_required)` and registered with one call in `sql_backend.py`, so that file stays under the
500-line limit.

- `200 {"master": {"dev_alice": ["TEAM_A"], ...}}`
- File missing → `404 {"error": "Team Mer master file not found: Master_MerDevTeam.xlsx"}`
  (basename only — don't leak server paths).
- Bad header / unreadable → `500 {"error": "<message>"}`.

### Dependency

`openpyxl==3.1.5` added to `requirements.txt` (the version installed on the dev PC).

## Frontend

| File | Change |
| ---- | ------ |
| `lib/constants.ts` | `C_KEY_MAP.createdBy = 'Created CBD by'`; aliases `createdcbdby`, `cbdcreatedby` (deliberately **not** `createdby` — a generic "Created By" column must never be picked up instead) |
| `lib/costsheet.ts` | Read the column per row; `CostsheetEntry.createdByVal`, `CostsheetMatch.createdByVal`. Missing column is **not** added to `missing` (display-only, like Version). |
| `lib/merTeam.ts` *(new)* | `MerTeamMaster` type, the two label constants, `merTeamsFor()`, `merTeamOptions()` |
| `lib/types.ts` | `CompRow.cCreatedBy: string`, `CompRow.merTeams: string[]` |
| `lib/comparison.ts` | `runComparison(dataA, dataBFiles, dataC, merMaster = null)`; fills the two fields once per PPS row, right after the Costsheet lookup |
| `lib/api.ts` | `fetchMerTeamMaster(): Promise<MerTeamMaster>` |
| `App.tsx` | `handleValidate` fetches the master first (failure → toast + `null`); `merTeamFilter` state; filter + search + Clear Filters |
| `components/ResultsToolbar.tsx` | Team Mer `<select>` |
| `components/ResultsTable.tsx` | Master Data group (2 leaf columns after `#`); every leaf index shifts by +2 |
| `lib/csv.ts` | `Team_Mer`, `Created_CBD_By` after `Row` |
| `styles/global.css`, `styles/tokens.css` | `th.hm` header colour for the Master Data group |

### `merTeamsFor(createdBy, cMatched, master)`

```
cMatched false              → ['(No Costsheet)']
createdBy blank             → ['(Unassigned)']
master null or no entry     → ['(Unassigned)']
otherwise                   → master[lower(trim(createdBy))]   (copy of the list)
```

## Edge cases and decided behaviour

- **Extended-size Costsheet row with an empty `Extended Size FOB`.** `lookupCostsheet` already
  reports these as unmatched, so they show `(No Costsheet)` even though a row exists. This
  follows the existing WISDOM match status on purpose — Team Mer always agrees with what the
  WISDOM columns show.
- **Non-USD (Not Compared) rows** still get their team; `Created CBD by` is metadata, like
  Version, and is filled whenever a Costsheet row matched.
- **Master fetch fails during Validate.** Validate still runs; every matched row reads
  `(Unassigned)`; one error toast says `Team Mer master not loaded: <reason>`.
- **Costsheet view lacks `Created CBD by`.** Every matched row reads `(Unassigned)`. No toolbar
  warning (the column is display-only).
- **Two rows in the master for the same dev + same team** → de-duplicated.
- **Team names keep their spelling** from the file (`Team D (X)`, not lower-cased); only the
  dev key is lower-cased.

## Deployment

The `.xlsx` is gitignored, so it must be copied by hand to the server's `DashBoard/Data/` folder
(or `MER_TEAM_MASTER_PATH` set in the server `.env`). The server also needs
`py -m pip install -r requirements.txt` for `openpyxl`, then a rebuilt `frontend/dist`.

## Verification

- **Backend:** new `tests/test_mer_team.py` (pytest) builds small workbooks in `tmp_path` and
  covers: normal load, case/space handling, multi-team dev, blank rows, reordered columns,
  missing header, mtime cache reload, and the route (401 / 200 / 404).
- **Frontend:** no test framework in the repo (unchanged decision from earlier features). A
  scratchpad Node harness esbuild-bundles the real `lib/` modules and checks `merTeamsFor`,
  `merTeamOptions`, Costsheet `createdByVal` extraction, and an end-to-end `runComparison` with
  synthetic rows. Plus `npm run build`.
- **Manual:** run the app, Validate, pick each team, confirm row counts and the column.
