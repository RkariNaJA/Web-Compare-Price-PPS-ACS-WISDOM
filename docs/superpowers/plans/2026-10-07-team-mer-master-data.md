# Team Mer Master Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each result row's **Team Mer** (from WISDOM's `Created CBD by`, looked up in `Data/Master_MerDevTeam.xlsx`) in a new **Master Data** column group, and let users filter the results by team.

**Architecture:** A new backend module `mer_team.py` reads the master `.xlsx` (cached by file mtime) and serves it at `GET /get_mer_team_master`. The frontend fetches it on Validate and passes it to `runComparison`, which reads `Created CBD by` from the **same winning Costsheet row** that already supplies Version / Cost Sheet No., and resolves it to a list of teams with a pure helper in `lib/merTeam.ts`. The toolbar, table and CSV then just read `CompRow.merTeams` / `CompRow.cCreatedBy`.

**Tech Stack:** Python 3.13 + Flask + openpyxl 3.1.5 (backend, pytest). TypeScript 5 strict + React 18 + Vite 5 (frontend). No frontend test framework — pure `lib/` code is checked by a scratchpad Node harness that esbuild-bundles the real modules.

**Spec:** `docs/superpowers/specs/2026-10-07-team-mer-master-data-design.md`

## Global Constraints

- The team comes from the **winning Costsheet row only** — do not change which row wins, any verdict, or any FOB logic.
- Labels are exact strings: `(No Costsheet)` when no Costsheet row matched; `(Unassigned)` when `Created CBD by` is blank, not in the master, or the master failed to load.
- A developer in several teams belongs to **all** of them; the column shows them joined with `, `.
- Dev lookup ignores case and surrounding spaces; team names keep the file's spelling.
- The master stays an `.xlsx`. **Never commit** `Data/Master_MerDevTeam.xlsx` or any real `.xlsx` (the repo is public; `*.xlsx` is gitignored — tests build their own workbooks in `tmp_path`).
- `Created CBD by` aliases are `createdcbdby` and `cbdcreatedby` only — **never** `createdby`.
- A missing `Created CBD by` column is **not** a toolbar warning (display-only, like Version).
- `sql_backend.py` must stay under 500 lines — the route lives in `mer_team.py`.
- CSV export keeps exporting **all** rows (not the filtered ones).
- Scratchpad harness files are never committed.

**Paths used below:**
- `$DB` = the `DashBoard` folder (repository root)
- `$FE` = `$DB\frontend`
- `$SP` = the current Claude session's scratchpad directory

## Review Focus

1. **A `Created CBD by` value like `constructor` or `__proto__`** must give `(Unassigned)`, not crash — the master arrives as a plain JSON object, so a naive `master[key]` returns `Object.prototype` members. Pinned in Task 3 (T3.6).
2. **The master file is replaced while the backend is running** — the next Validate must see the new teams without a restart. Pinned in Task 1 (`test_reload_when_file_changes`).
3. **Master `.xlsx` with header cells in a different order, different case, or trailing spaces** (`mer_dev `) must still load. Pinned in Task 1 (`test_header_order_and_case_do_not_matter`).
4. **Results table column widths after the +2 shift** — a mis-numbered `resizer()` makes the wrong column resize. Pinned in Task 5 Step 4 (manual drag check of three columns).
5. **Master fetch fails (file missing on the server)** — Validate must still produce results, with one clear toast. Pinned in Task 4 (T4.4 harness with `null` master) and Task 5 Step 4 (manual check with the file renamed).

---

## File Structure

| File | Responsibility | Change |
| ---- | -------------- | ------ |
| `mer_team.py` | Load master `.xlsx`, mtime cache, route | **Create** |
| `tests/test_mer_team.py` | Backend tests | **Create** |
| `sql_backend.py` | Flask app | Import + register route; index text |
| `requirements.txt` | Runtime deps | `openpyxl==3.1.5` |
| `.env.example` | Config template | `MER_TEAM_MASTER_PATH=` |
| `frontend/src/lib/merTeam.ts` | Team resolution helpers | **Create** |
| `frontend/src/lib/constants.ts` | Costsheet column names | `createdBy` key + aliases |
| `frontend/src/lib/costsheet.ts` | Costsheet index/lookup | carry `createdByVal` |
| `frontend/src/lib/types.ts` | `CompRow` | `cCreatedBy`, `merTeams` |
| `frontend/src/lib/comparison.ts` | `runComparison` | `merMaster` param; fill fields |
| `frontend/src/lib/api.ts` | Backend client | `fetchMerTeamMaster` |
| `frontend/src/App.tsx` | State, filters | fetch on Validate; `merTeamFilter` |
| `frontend/src/components/ResultsToolbar.tsx` | Filters UI | Team Mer `<select>` |
| `frontend/src/components/ResultsTable.tsx` | Grid | Master Data group, +2 index shift |
| `frontend/src/lib/csv.ts` | Export | two columns |
| `frontend/src/styles/tokens.css`, `global.css` | Colours | `--m`, `--m-2`, `th.hm` |
| `docs/HANDOVER.md` | Dev doc | file map + WISDOM logic + deploy note |
| `$SP/verify-mer-team.mjs` | Harness (**scratchpad only**) | Created Task 3, extended Task 4 |

---

### Task 1: Backend master loader (`mer_team.py`)

**Files:**
- Create: `mer_team.py`
- Create: `tests/test_mer_team.py`
- Modify: `requirements.txt` (append)

**Interfaces:**
- Produces: `mer_team.load_master(path: str) -> dict[str, list[str]]` (raises `FileNotFoundError`, `ValueError`); `mer_team.master_path() -> str`; `mer_team.DEFAULT_PATH`. Task 2 adds `register_routes` to the same file.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_mer_team.py`:

```python
import os

import openpyxl
import pytest

import mer_team


def make_master(path, rows, header=("MER_TEAM", "MER_DEV")):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(list(header))
    for r in rows:
        ws.append(list(r))
    wb.save(path)
    return str(path)


@pytest.fixture(autouse=True)
def clear_cache():
    mer_team._cache.clear()
    yield
    mer_team._cache.clear()


def test_loads_dev_to_team(tmp_path):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "dev_alice"), ("TEAM_C", "dev_bob")])
    assert mer_team.load_master(p) == {"dev_alice": ["TEAM_A"], "dev_bob": ["TEAM_C"]}


def test_dev_key_is_lowercased_and_trimmed_team_keeps_spelling(tmp_path):
    p = make_master(tmp_path / "m.xlsx", [(" Team D (X) ", "  Dev_Alice ")])
    assert mer_team.load_master(p) == {"dev_alice": ["Team D (X)"]}


def test_dev_in_two_teams_gets_both_sorted_and_deduped(tmp_path):
    p = make_master(
        tmp_path / "m.xlsx",
        [("TEAM_B", "dev_carol"), ("Team D (X)", "dev_carol"), ("TEAM_B", "dev_carol")],
    )
    assert mer_team.load_master(p) == {"dev_carol": ["TEAM_B", "Team D (X)"]}


def test_blank_rows_and_blank_cells_are_skipped(tmp_path):
    p = make_master(
        tmp_path / "m.xlsx",
        [("TEAM_A", "mpa"), (None, "mpb"), ("TEAM_C", None), (None, None), ("  ", "mpc")],
    )
    assert mer_team.load_master(p) == {"mpa": ["TEAM_A"]}


def test_header_order_and_case_do_not_matter(tmp_path):
    p = make_master(
        tmp_path / "m.xlsx", [("mpa", "TEAM_A")], header=("mer_dev ", "Mer_Team")
    )
    assert mer_team.load_master(p) == {"mpa": ["TEAM_A"]}


def test_missing_header_raises_value_error(tmp_path):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "mpa")], header=("TEAM", "MER_DEV"))
    with pytest.raises(ValueError, match="MER_TEAM"):
        mer_team.load_master(p)


def test_missing_file_raises_file_not_found(tmp_path):
    with pytest.raises(FileNotFoundError):
        mer_team.load_master(str(tmp_path / "nope.xlsx"))


def test_reload_when_file_changes(tmp_path):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "mpa")])
    assert mer_team.load_master(p) == {"mpa": ["TEAM_A"]}
    make_master(tmp_path / "m.xlsx", [("TEAM_C", "mpa")])
    st = os.stat(p)
    os.utime(p, (st.st_atime, st.st_mtime + 10))  # guarantee a different mtime
    assert mer_team.load_master(p) == {"mpa": ["TEAM_C"]}


def test_unchanged_file_is_served_from_cache(tmp_path, monkeypatch):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "mpa")])
    mer_team.load_master(p)
    monkeypatch.setattr(mer_team, "_read", lambda path: pytest.fail("re-read an unchanged file"))
    assert mer_team.load_master(p) == {"mpa": ["TEAM_A"]}


def test_master_path_default_and_env_override(monkeypatch):
    monkeypatch.delenv("MER_TEAM_MASTER_PATH", raising=False)
    assert mer_team.master_path() == mer_team.DEFAULT_PATH
    assert mer_team.DEFAULT_PATH.endswith(os.path.join("Data", "Master_MerDevTeam.xlsx"))
    monkeypatch.setenv("MER_TEAM_MASTER_PATH", r"D:\x\y.xlsx")
    assert mer_team.master_path() == r"D:\x\y.xlsx"
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `$DB`): `py -m pytest tests/test_mer_team.py -v`
Expected: collection ERROR — `ModuleNotFoundError: No module named 'mer_team'`.

- [ ] **Step 3: Write the implementation**

Create `mer_team.py`:

```python
"""Team Mer master data: maps a CBD creator (MER_DEV) to their team(s) (MER_TEAM).

The source is an .xlsx the master data team maintains (gitignored — copied to the
server by hand). It is cached by file modified-time, so a replaced file is picked
up on the next request without restarting the backend.
"""
import os

import openpyxl

DEFAULT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "Data", "Master_MerDevTeam.xlsx"
)
TEAM_COL = "MER_TEAM"
DEV_COL = "MER_DEV"

# path -> (mtime, master)
_cache: dict[str, tuple[float, dict[str, list[str]]]] = {}


def master_path() -> str:
    """MER_TEAM_MASTER_PATH from .env, else DashBoard/Data/Master_MerDevTeam.xlsx."""
    return os.getenv("MER_TEAM_MASTER_PATH") or DEFAULT_PATH


def _cell(v) -> str:
    return str(v).strip() if v is not None else ""


def _read(path: str) -> dict[str, list[str]]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        rows = wb.active.iter_rows(values_only=True)
        header = [_cell(h).upper() for h in next(rows, ())]
        for col in (TEAM_COL, DEV_COL):
            if col not in header:
                raise ValueError(f"Team Mer master is missing the {col} column")
        ti, di = header.index(TEAM_COL), header.index(DEV_COL)
        teams: dict[str, set[str]] = {}
        for row in rows:
            team = _cell(row[ti]) if ti < len(row) else ""
            dev = _cell(row[di]).lower() if di < len(row) else ""
            if team and dev:
                teams.setdefault(dev, set()).add(team)
        return {dev: sorted(ts) for dev, ts in teams.items()}
    finally:
        wb.close()


def load_master(path: str) -> dict[str, list[str]]:
    """{lower-cased MER_DEV: sorted [MER_TEAM, ...]}. Raises FileNotFoundError / ValueError."""
    mtime = os.path.getmtime(path)  # FileNotFoundError when the file is missing
    hit = _cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    master = _read(path)
    _cache[path] = (mtime, master)
    return master
```

Append to `requirements.txt` (after `waitress==3.0.0`, on its own line):

```
openpyxl==3.1.5
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `py -m pytest tests/test_mer_team.py -v`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add mer_team.py tests/test_mer_team.py requirements.txt
git commit -m "feat: load Team Mer master xlsx with mtime cache"
```

---

### Task 2: Backend route `GET /get_mer_team_master`

**Files:**
- Modify: `mer_team.py` (append `register_routes`)
- Modify: `sql_backend.py:11-14` (import), after the `require_manage` guard (~line 77, register), `:483-490` (index text)
- Modify: `.env.example` (append under the SQL Server section)
- Test: `tests/test_mer_team.py` (append)

**Interfaces:**
- Consumes: `load_master`, `master_path` from Task 1; `login_required` from `sql_backend.py:43`.
- Produces: `GET /get_mer_team_master` → `200 {"master": {...}}` | `401` | `404 {"error"}` | `500 {"error"}`. Task 5's `fetchMerTeamMaster` calls it.

- [ ] **Step 1: Write the failing route tests**

Append to `tests/test_mer_team.py`:

```python
from conftest import login_as


def test_route_requires_login(client):
    assert client.get("/get_mer_team_master").status_code == 401


def test_route_returns_master(client, tmp_path, monkeypatch):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "Dev_Alice")])
    monkeypatch.setenv("MER_TEAM_MASTER_PATH", p)
    login_as(client)
    resp = client.get("/get_mer_team_master")
    assert resp.status_code == 200
    assert resp.get_json() == {"master": {"dev_alice": ["TEAM_A"]}}


def test_route_missing_file_is_404_without_leaking_the_path(client, tmp_path, monkeypatch):
    monkeypatch.setenv("MER_TEAM_MASTER_PATH", str(tmp_path / "secret_dir" / "Master.xlsx"))
    login_as(client)
    resp = client.get("/get_mer_team_master")
    assert resp.status_code == 404
    err = resp.get_json()["error"]
    assert "Master.xlsx" in err and "secret_dir" not in err


def test_route_bad_header_is_500(client, tmp_path, monkeypatch):
    p = make_master(tmp_path / "m.xlsx", [("x", "y")], header=("A", "B"))
    monkeypatch.setenv("MER_TEAM_MASTER_PATH", p)
    login_as(client)
    resp = client.get("/get_mer_team_master")
    assert resp.status_code == 500
    assert "MER_TEAM" in resp.get_json()["error"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `py -m pytest tests/test_mer_team.py -v -k route`
Expected: `test_route_requires_login` and the others FAIL with status 404 (route not registered) — e.g. `assert 404 == 401`.

- [ ] **Step 3: Implement**

Append to `mer_team.py`:

```python
def register_routes(app, login_required):
    """Attach GET /get_mer_team_master. Lives here so sql_backend.py stays small."""
    from flask import jsonify

    @app.route("/get_mer_team_master", methods=["GET"])
    @login_required
    def get_mer_team_master():
        path = master_path()
        try:
            return jsonify({"master": load_master(path)})
        except FileNotFoundError:
            # Basename only — never leak server folder names to the browser.
            return jsonify(
                {"error": f"Team Mer master file not found: {os.path.basename(path)}"}
            ), 404
        except Exception as e:
            print(f"[MER TEAM] Error: {e}")
            return jsonify({"error": str(e)}), 500
```

In `sql_backend.py`, add the import after `import logs_db` (line 14):

```python
import mer_team
```

Directly after the `require_manage` function ends (before the first `@app.route` that follows it), add:

```python
# Team Mer master (Data/Master_MerDevTeam.xlsx) — route lives in mer_team.py.
mer_team.register_routes(app, login_required)
```

In `index()`, replace:

```python
        '&nbsp;&nbsp;<b>/get_costsheet_data</b> — dbo.VIEW_COSTSHEET_WISDOM'
```

with:

```python
        '&nbsp;&nbsp;<b>/get_costsheet_data</b> — dbo.VIEW_COSTSHEET_WISDOM<br>'
        '&nbsp;&nbsp;<b>/get_mer_team_master</b> — Team Mer master (.xlsx)'
```

Append to `.env.example`, right after `DB_TABLE_C=dbo.VIEW_COSTSHEET_WISDOM`:

```
# Team Mer master (.xlsx with MER_TEAM / MER_DEV columns). Blank = DashBoard\Data\Master_MerDevTeam.xlsx
MER_TEAM_MASTER_PATH=
```

- [ ] **Step 4: Run the full backend suite**

Run: `py -m pytest -q`
Expected: all pass (previous tests + 14 in `test_mer_team.py`). Also run `wc -l sql_backend.py` (or `(Get-Content sql_backend.py).Count`) — must be < 500.

- [ ] **Step 5: Commit**

```bash
git add mer_team.py sql_backend.py .env.example tests/test_mer_team.py
git commit -m "feat: serve Team Mer master at /get_mer_team_master"
```

---

### Task 3: Frontend team resolver (`lib/merTeam.ts`) + harness

**Files:**
- Create: `frontend/src/lib/merTeam.ts`
- Modify: `frontend/src/lib/types.ts` (add two `CompRow` fields — needed by `merTeamOptions`' type)
- Create: `$SP/verify-mer-team.mjs` (scratchpad only)

**Interfaces:**
- Produces:
  - `type MerTeamMaster = Record<string, string[]>`
  - `const NO_COSTSHEET = '(No Costsheet)'`, `const UNASSIGNED = '(Unassigned)'`
  - `merTeamsFor(createdBy: string, cMatched: boolean, master: MerTeamMaster | null): string[]`
  - `merTeamOptions(rows: Pick<CompRow, 'merTeams'>[]): string[]`
  - `CompRow.cCreatedBy: string`, `CompRow.merTeams: string[]`

> Adding the two required `CompRow` fields makes `npm run build` fail until Task 4 fills them in `comparison.ts`. That is expected — do **not** run the build in this task; Task 4 ends with a green build.

- [ ] **Step 1: Write the failing harness**

Create `$SP/verify-mer-team.mjs`:

```js
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const FE = process.argv[2];   // absolute path to frontend/
const SP = process.argv[3];   // absolute path to the scratchpad
const esbuild = await import(
  pathToFileURL(path.join(FE, 'node_modules', 'esbuild', 'lib', 'main.js')).href
);

async function load(name) {
  const outfile = path.join(SP, `bundle-${name}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(FE, 'src', 'lib', `${name}.ts`)],
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href + '?t=' + Date.now());
}

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++; else failures.push(`${label}\n     expected ${e}\n     actual   ${a}`);
}

const mt = await load('merTeam');
const master = {
  dev_alice: ['TEAM_A'],
  dev_carol: ['Team D (X)', 'TEAM_B'],
};

// ── T3 merTeamsFor ──────────────────────────────────────────────────────────
check('T3.1 labels', [mt.NO_COSTSHEET, mt.UNASSIGNED], ['(No Costsheet)', '(Unassigned)']);
check('T3.2 known dev', mt.merTeamsFor('dev_alice', true, master), ['TEAM_A']);
check('T3.3 case + spaces', mt.merTeamsFor('  Dev_Alice ', true, master), ['TEAM_A']);
check('T3.4 two teams', mt.merTeamsFor('dev_carol', true, master), ['Team D (X)', 'TEAM_B']);
check('T3.5 unknown dev', mt.merTeamsFor('nobody', true, master), ['(Unassigned)']);
check('T3.6 proto keys', ['constructor', '__proto__', 'toString', 'hasOwnProperty']
  .map((k) => mt.merTeamsFor(k, true, master)), Array(4).fill(['(Unassigned)']));
check('T3.7 blank creator', mt.merTeamsFor('   ', true, master), ['(Unassigned)']);
check('T3.8 null master', mt.merTeamsFor('dev_alice', true, null), ['(Unassigned)']);
check('T3.9 no costsheet wins', mt.merTeamsFor('dev_alice', false, master), ['(No Costsheet)']);
const got = mt.merTeamsFor('dev_carol', true, master);
got.push('MUTATED');
check('T3.10 returns a copy', master.dev_carol, ['Team D (X)', 'TEAM_B']);

// ── T3 merTeamOptions ───────────────────────────────────────────────────────
check('T3.11 options order', mt.merTeamOptions([
  { merTeams: ['(No Costsheet)'] },
  { merTeams: ['TEAM_B', 'Team D (X)'] },
  { merTeams: ['(Unassigned)'] },
  { merTeams: ['TEAM_C'] },
  { merTeams: ['TEAM_B'] },
]), ['TEAM_B', 'TEAM_C', 'Team D (X)', '(Unassigned)', '(No Costsheet)']);
check('T3.12 labels only when present', mt.merTeamOptions([{ merTeams: ['TEAM_C'] }]), ['TEAM_C']);
check('T3.13 empty', mt.merTeamOptions([]), []);

// TASK4_CHECKS

console.log(`${pass} passed, ${failures.length} failed`);
failures.forEach((f) => console.log('  FAIL ' + f));
process.exit(failures.length ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node "$SP/verify-mer-team.mjs" "$FE" "$SP"`
Expected: esbuild error `Could not resolve ".../src/lib/merTeam.ts"` (non-zero exit).

- [ ] **Step 3: Implement**

Create `frontend/src/lib/merTeam.ts`:

```ts
/**
 * Team Mer resolution. A results row's team comes from who created its CBD in
 * WISDOM (`Created CBD by` on the winning Costsheet row), looked up in the master
 * file served by GET /get_mer_team_master. Pure — no React, no fetch.
 */
import type { CompRow } from './types';

// Lower-cased MER_DEV → that developer's team(s), as served by the backend.
export type MerTeamMaster = Record<string, string[]>;

// Shown instead of a team so unassignable rows can be filtered and fixed.
export const NO_COSTSHEET = '(No Costsheet)';
export const UNASSIGNED = '(Unassigned)';

// The row's team list. A developer in several teams belongs to all of them, so a
// filter on any of those teams keeps the row. Always returns a fresh array.
export function merTeamsFor(
  createdBy: string,
  cMatched: boolean,
  master: MerTeamMaster | null,
): string[] {
  if (!cMatched) return [NO_COSTSHEET];
  const key = createdBy.trim().toLowerCase();
  // hasOwn guard: the master is a plain JSON object, so `master['constructor']`
  // would otherwise return Object.prototype members.
  const teams =
    key && master && Object.prototype.hasOwnProperty.call(master, key) ? master[key] : null;
  return Array.isArray(teams) && teams.length ? [...teams] : [UNASSIGNED];
}

// Filter dropdown options: real teams A→Z, then the two labels (only if present).
export function merTeamOptions(rows: Pick<CompRow, 'merTeams'>[]): string[] {
  const all = new Set<string>();
  rows.forEach((r) => r.merTeams.forEach((t) => all.add(t)));
  const real = [...all].filter((t) => t !== UNASSIGNED && t !== NO_COSTSHEET).sort();
  return [...real, ...[UNASSIGNED, NO_COSTSHEET].filter((t) => all.has(t))];
}
```

In `frontend/src/lib/types.ts`, inside `CompRow`, directly after the `cCostSheetNo` line, add:

```ts
  cCreatedBy: string;          // Costsheet "Created CBD by" of the winning row ('' when no Costsheet match)
  merTeams: string[];          // Team Mer(s) from the master file, or one '(No Costsheet)' / '(Unassigned)' label
```

- [ ] **Step 4: Run the harness to verify it passes**

Run: `node "$SP/verify-mer-team.mjs" "$FE" "$SP"`
Expected: `13 passed, 0 failed`.

- [ ] **Step 5: Commit** (harness stays in the scratchpad)

```bash
git add frontend/src/lib/merTeam.ts frontend/src/lib/types.ts
git commit -m "feat: add Team Mer resolver helpers"
```

---

### Task 4: Carry `Created CBD by` through Costsheet lookup and `runComparison`

**Files:**
- Modify: `frontend/src/lib/constants.ts` (`C_KEY_MAP`, `C_KEY_ALIASES`)
- Modify: `frontend/src/lib/costsheet.ts` (`CostsheetEntry`, `CostsheetMatch`, `buildCostsheetIndex`, `lookupCostsheet`)
- Modify: `frontend/src/lib/comparison.ts` (imports, `runComparison` signature, after the `lookupCostsheet` call ~line 384, both `compRows.push` objects)
- Test: `$SP/verify-mer-team.mjs` (replace the `// TASK4_CHECKS` line)

**Interfaces:**
- Consumes: `merTeamsFor`, `MerTeamMaster` (Task 3).
- Produces: `CostsheetMatch.createdByVal: string`; `runComparison(dataA, dataBFiles, dataC, merMaster: MerTeamMaster | null = null): CompareResult` with every row's `cCreatedBy` / `merTeams` filled. Task 5 calls the 4-arg form.

- [ ] **Step 1: Add the failing checks**

In `$SP/verify-mer-team.mjs`, replace the line `// TASK4_CHECKS` with:

```js
// ── T4 Costsheet extraction + runComparison end-to-end ──────────────────────
const cs = await load('costsheet');
const cmp = await load('comparison');

const csHdr = ['Season', 'Style No.', 'Color', 'Factory', 'Size', 'Final FOB',
  'Extended Size FOB', 'First Input Date', 'CBD Version', 'Cost Sheet No.', 'Created CBD by'];
const dataC = { name: 'CS', headers: csHdr, rows: [
  ['FA27', 'AB1234', '010', 'HIT', 'ALL_REG_SIZE', '5.00', '6.00', '2026-08-01', '1', 'CS-1', ' Dev_Alice '],
  ['FA27', 'CD5678', '010', 'HIT', 'ALL_REG_SIZE', '7.00', '8.00', '2026-08-01', '2', 'CS-2', 'nobody'],
  ['FA27', 'EF0001', '010', 'HIT', 'ALL_REG_SIZE', '9.00', '9.50', '2026-08-01', '3', 'CS-3', 'dev_carol'],
] };

// T4.1 the winning row's creator comes through lookupCostsheet, trimmed
const idx = cs.buildCostsheetIndex(dataC);
check('T4.1 no missing-column warning', idx.missing, []);
// Keys are what normalizeJoinKey produces today (verified 2026-10-07: 'fa27|ab1234|010|hit').
check('T4.1 createdByVal',
  cs.lookupCostsheet(idx, 'ALL_REG_SIZE_RB', 'fa27|ab1234|010|hit', 'fa27|ab1234|hit')?.createdByVal,
  'Dev_Alice');

// T4.2 view without the column: no warning, empty value
const idxNoCol = cs.buildCostsheetIndex({ ...dataC, headers: csHdr.slice(0, 10),
  rows: dataC.rows.map((r) => r.slice(0, 10)) });
check('T4.2 no warning when column absent', idxNoCol.missing, []);

// T4.3 end-to-end
const dataA = { name: 'ACS',
  headers: ['Season', 'EXTRACTED_SIZE', 'StyleNumber', 'ColorwayCode', 'FactoryCode', 'FinalFOB', 'ExtSzFOB', 'CBDID'],
  rows: [
    ['FA27', 'ALL_REG_SIZE_RB', 'AB1234', '010', 'HIT', '5.00', '6.00', 'FA27-HIT-AB1234-S-010-ALL_REG_SIZE-RB'],
    ['FA27', 'ALL_REG_SIZE_RB', 'CD5678', '010', 'HIT', '7.00', '8.00', 'FA27-HIT-CD5678-S-010-ALL_REG_SIZE-RB'],
  ] };
const ppsHdr = ['MSC_CODE', 'RESPONSIBLE_DEVELOPER', 'SEASON_YEAR', 'STYLE', 'COLOR', 'FTYCODE',
  'SIZE_DATA', 'LOCAL_QUOTE_AMOUNT', 'LOCAL_CURRENCY', 'INSERT_DATE'];
const dataB = [{ name: 'PPS (HIT)', colorIdx: 0, headers: ppsHdr, rows: [
  ['M1', 'DEV ONE', 'FA27', 'AB1234', '010', 'HIT', '', '5.00', 'USD', '2026-09-01'],  // ACS + CS, known dev
  ['M2', 'DEV TWO', 'FA27', 'CD5678', '010', 'HIT', '', '7.00', 'USD', '2026-09-01'],  // ACS + CS, unknown dev
  ['M3', 'DEV THREE', 'FA27', 'EF0001', '010', 'HIT', '', '9.00', 'USD', '2026-09-01'], // no ACS, CS, 2 teams
  ['M4', 'DEV FOUR', 'FA27', 'ZZ9999', '010', 'HIT', '', '9.00', 'USD', '2026-09-01'],  // no ACS, no CS
] }];
const pick = (res) => res.rows.map((r) => [r.mscCode, r.cCreatedBy, r.merTeams]);

check('T4.3 with master', pick(cmp.runComparison(dataA, dataB, dataC, master)), [
  ['M1', 'Dev_Alice', ['TEAM_A']],
  ['M2', 'nobody', ['(Unassigned)']],
  ['M3', 'dev_carol', ['Team D (X)', 'TEAM_B']],
  ['M4', '', ['(No Costsheet)']],
]);
// T4.4 master failed to load → matched rows are Unassigned, Validate still works
check('T4.4 null master', pick(cmp.runComparison(dataA, dataB, dataC, null)).map((r) => r[2]),
  [['(Unassigned)'], ['(Unassigned)'], ['(Unassigned)'], ['(No Costsheet)']]);
// T4.5 3-arg call still compiles/behaves (default param)
check('T4.5 default param', pick(cmp.runComparison(dataA, dataB, dataC))[0][2], ['(Unassigned)']);
// T4.6 Costsheet not loaded at all
check('T4.6 no costsheet', pick(cmp.runComparison(dataA, dataB, null, master)).map((r) => r[2]),
  Array(4).fill(['(No Costsheet)']));
// T4.7 verdicts unchanged by the feature
check('T4.7 verdicts', cmp.runComparison(dataA, dataB, dataC, master).rows.map((r) => cmp.verdictOf(r)),
  cmp.runComparison(dataA, dataB, dataC, null).rows.map((r) => cmp.verdictOf(r)));
```

- [ ] **Step 2: Run to verify it fails**

Run: `node "$SP/verify-mer-team.mjs" "$FE" "$SP"`
Expected: T3 checks pass; T4.1 / T4.3 / T4.4 / T4.5 / T4.6 FAIL (`createdByVal` and `cCreatedBy` are `undefined`, `merTeams` missing). Exit code 1.

- [ ] **Step 3: Implement**

`frontend/src/lib/constants.ts` — in `C_KEY_MAP`, after the `costSheetNo` line:

```ts
  createdBy: 'Created CBD by',     // who created the CBD — looked up in the Team Mer master
```

In `C_KEY_ALIASES`, after the `costSheetNo` line:

```ts
  // Deliberately NOT 'createdby': a generic "Created By" column must never be picked up instead.
  createdBy: ['createdcbdby', 'cbdcreatedby'],
```

`frontend/src/lib/costsheet.ts`:

1. In `CostsheetEntry`, after `costSheetNoVal`:
   ```ts
     createdByVal: string;    // `Created CBD by` — drives Team Mer
   ```
2. In `CostsheetMatch`, after `costSheetNoVal`:
   ```ts
     createdByVal: string;    // `Created CBD by` of the winning Costsheet row
   ```
3. In `buildCostsheetIndex`, after `const costSheetNoIdx = findCostsheetIdx(hdr, 'costSheetNo');`:
   ```ts
     const createdByIdx = findCostsheetIdx(hdr, 'createdBy');  // display-only, like Version
   ```
   After the `const costSheetNoVal = …` line:
   ```ts
       const createdByVal = createdByIdx !== -1 ? String(row[createdByIdx] ?? '').trim() : '';
   ```
   Change the `entry` literal to end with `…, versionVal, costSheetNoVal, createdByVal };`
4. In `lookupCostsheet`, add `createdByVal: '',` to `empty` (after `costSheetNoVal: '',`) and `createdByVal: best.createdByVal || '',` to the returned object (after `costSheetNoVal: …`).

`frontend/src/lib/comparison.ts`:

1. Imports — after the `./costsheet` import:
   ```ts
   import { merTeamsFor, type MerTeamMaster } from './merTeam';
   ```
2. Signature:
   ```ts
   export function runComparison(
     dataA: TableData,
     dataBFiles: PPSFile[],
     dataC: TableData | null,
     merMaster: MerTeamMaster | null = null,
   ): CompareResult {
   ```
   and add to the header comment block above it: `// merMaster: Team Mer master (null = not loaded → matched rows read "(Unassigned)").`
3. Directly after `const cResult = lookupCostsheet(cIdx, bConvertedSize, cJoinKey, cJoinKeyNC);`:
   ```ts
         // Team Mer: who created the winning Costsheet row's CBD, looked up in the
         // master. Computed once here so the ACS-hit and no-key branches agree.
         const cMatchedForTeam = cResult?.matched ?? false;
         const cCreatedBy = cResult && cMatchedForTeam ? cResult.createdByVal : '';
         const merTeams = merTeamsFor(cCreatedBy, cMatchedForTeam, merMaster);
   ```
4. In **both** `compRows.push({ … })` objects, directly after `cCostSheetNo,` add:
   ```ts
             cCreatedBy,
             merTeams,
   ```
   (`cCostSheetNo,` followed by `cDateStr,` appears exactly twice — once per push.)

- [ ] **Step 4: Run the harness and the type-check**

Run: `node "$SP/verify-mer-team.mjs" "$FE" "$SP"`
Expected: `21 passed, 0 failed` (13 from Task 3 + 8 here).

Run (in `$FE`): `npx tsc -b`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/constants.ts frontend/src/lib/costsheet.ts frontend/src/lib/comparison.ts
git commit -m "feat: resolve Team Mer from Costsheet Created CBD by"
```

---

### Task 5: UI — fetch, filter, Master Data columns, CSV

**Files:**
- Modify: `frontend/src/lib/api.ts` (after `fetchPPS`)
- Modify: `frontend/src/App.tsx` (imports, filter state, `clearAllFilters`, `handleValidate`, `filtered`, toolbar props)
- Modify: `frontend/src/components/ResultsToolbar.tsx` (props, options, select, `anyFilterActive`)
- Modify: `frontend/src/components/ResultsTable.tsx` (`colCount`, `ci`, headers, body)
- Modify: `frontend/src/lib/csv.ts`
- Modify: `frontend/src/styles/tokens.css`, `frontend/src/styles/global.css`

**Interfaces:**
- Consumes: `runComparison(…, merMaster)` (Task 4); `merTeamOptions`, `NO_COSTSHEET`, `UNASSIGNED`, `MerTeamMaster` (Task 3); `/get_mer_team_master` (Task 2).
- Produces: `fetchMerTeamMaster(): Promise<MerTeamMaster>`.

- [ ] **Step 1: `api.ts`, `csv.ts`, styles**

`frontend/src/lib/api.ts` — add `MerTeamMaster` import at the top:

```ts
import type { MerTeamMaster } from './merTeam';
```

and after `fetchPPS`:

```ts
// GET /get_mer_team_master — lower-cased MER_DEV → [MER_TEAM, …] from the master .xlsx.
// Parses the body even on 404/500 so the backend's message reaches the toast.
export async function fetchMerTeamMaster(): Promise<MerTeamMaster> {
  const res = await fetch(`${BACKEND_URL}/get_mer_team_master?t=${Date.now()}`, CREDS);
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.master as MerTeamMaster;
}
```

`frontend/src/lib/csv.ts` — in `hdr`, after `'Row',`:

```ts
    'Team_Mer',
    'Created_CBD_By',
```

and in the row array, after `r.rowIdx,`:

```ts
        r.merTeams.join(', '),
        r.cCreatedBy,
```

`frontend/src/styles/tokens.css` — in the light `:root`, after the `--c-glow` line:

```css

  --m: #6b7f86;          /* Master Data — nezumi teal-grey */
  --m-2: #4f6268;
```

in the `@media (prefers-color-scheme: dark)` block, after `--c-2: #b0ba9e;`:

```css
    --m: #9fb3b9;
    --m-2: #b6c6cb;
```

in the `:root[data-theme='light']` block, after `--c: #79866a;  --c-2: #566448;`:

```css
  --m: #6b7f86;  --m-2: #4f6268;
```

and in the `:root[data-theme='dark']` block, after `--c: #9ba687;  --c-2: #b0ba9e;`:

```css
  --m: #9fb3b9;  --m-2: #b6c6cb;
```

(All four blocks must get the tokens, or a forced theme would show the header with no colour.)

`frontend/src/styles/global.css` — after the `table.result thead th.hc { … }` rule:

```css
table.result thead th.hm {
  color: var(--m-2);
}
```

- [ ] **Step 2: `ResultsToolbar.tsx`**

Import (top of file, with the other imports):

```ts
import { merTeamOptions } from '../lib/merTeam';
```

`Props` — after `setFactoryFilter`:

```ts
  merTeamFilter: string;
  setMerTeamFilter: (s: string) => void;
```

Destructure `merTeamFilter, setMerTeamFilter,` after `setFactoryFilter,`.

After the `mscCodes` const:

```ts
  const merTeams = merTeamOptions(rows);
```

`anyFilterActive` becomes:

```ts
  const anyFilterActive =
    !allActive || !!search || !!seasonFilter || !!factoryFilter || !!merTeamFilter ||
    !!developerFilter || !!mscCodeFilter;
```

After the Factory `</select>`:

```tsx
      {/* Team Mer — exact pick. A row whose creator is in two teams appears under both. */}
      <select
        className="filter-select"
        value={merTeamFilter}
        onChange={(e) => setMerTeamFilter(e.target.value)}
      >
        <option value="">All Team Mer</option>
        {merTeams.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
```

- [ ] **Step 3: `App.tsx`**

Imports — change the api import and add the type:

```ts
import { fetchAnnotations, fetchMerTeamMaster, saveAnnotations } from './lib/api';
import type { MerTeamMaster } from './lib/merTeam';
```

State — after `const [factoryFilter, setFactoryFilter] = useState('');`:

```ts
  const [merTeamFilter, setMerTeamFilter] = useState('');
```

`clearAllFilters` — after `setFactoryFilter('');` add `setMerTeamFilter('');`.

`handleValidate` — make it `async` and fetch the master before comparing. Replace from `const handleValidate = () => {` through the line `const result = runComparison(dataA, dataBFiles, dataC);` with:

```ts
  const handleValidate = async () => {
    if (!dataA) {
      toast('Load ACS DB data first', 'err');
      return;
    }
    if (!dataBFiles.length) {
      toast('Load at least one PPS factory from DB', 'err');
      return;
    }
    // Re-read the Team Mer master on every Validate so a replaced .xlsx shows up
    // without a reload. A failure is not fatal: rows read "(Unassigned)".
    let merMaster: MerTeamMaster | null = null;
    try {
      merMaster = await fetchMerTeamMaster();
    } catch (err) {
      toast(`Team Mer master not loaded: ${(err as Error).message}`, 'err');
    }
    try {
      const result = runComparison(dataA, dataBFiles, dataC, merMaster);
```

(the rest of the function is unchanged).

`filtered` — after the `factoryFilter` block:

```ts
    // Team Mer: exact pick; a row in several teams matches any of them.
    if (merTeamFilter) {
      rows = rows.filter((r) => r.merTeams.includes(merTeamFilter));
    }
```

In the search `||` chain, after `r.responsibleDeveloper.toLowerCase().includes(q) ||` add:

```ts
          r.merTeams.some((t) => t.toLowerCase().includes(q)) ||
          r.cCreatedBy.toLowerCase().includes(q) ||
```

Add `merTeamFilter` to the `useMemo` dependency array (after `factoryFilter`).

`<ResultsToolbar …>` — after `setFactoryFilter={setFactoryFilter}`:

```tsx
            merTeamFilter={merTeamFilter}
            setMerTeamFilter={setMerTeamFilter}
```

- [ ] **Step 4: `ResultsTable.tsx` — Master Data group (every leaf index shifts +2)**

Import:

```ts
import { NO_COSTSHEET, UNASSIGNED } from '../lib/merTeam';
```

Update the file's top doc comment: after the sentence ending "…Max Input Date columns appear." add `A "Master Data" group (Team Mer, Created CBD by) sits right after the # column.`

Change:

```ts
  const colCount = hasC ? 24 : 18; // leaf columns, must match the header rows below
```
to
```ts
  const colCount = hasC ? 26 : 20; // leaf columns, must match the header rows below
```

and `ci` to:

```ts
  const ci = {
    used: hasC ? 13 : 12,
    ppsFob: hasC ? 14 : 13,
    acsFob: hasC ? 15 : 14,
  };
```

Header row 1 — after `<th className="hrow" rowSpan={2}>#{resizer(0)}</th>` insert:

```tsx
            <th className="hm grp" colSpan={2}>Master Data</th>
```

and renumber in row 1: `MSC_CODE{resizer(3)}`, `RESPONSIBLE_DEVELOPER{resizer(4)}`, `Version{resizer(18)}`, `Cost Sheet No{resizer(19)}`. (The `colCount - n` ones need no change.)

Header row 2 — insert as the **first two** cells (before Season):

```tsx
            <th className="hm grp">Team Mer{resizer(1)}</th>
            <th className="hm">Created CBD by{resizer(2)}</th>
```

and renumber in row 2: Season `5`, Size `6`, Style `7`, Color `8`, Factory `9`, PPS SIZE `10`, ACS CBDID SIZE `11`, WISDOM SIZE `12`, the two WISDOM `Value` cells `16` and `17`, Max Date `20`.

Full new leaf map, for checking (hasC): `0 #, 1 Team Mer, 2 Created CBD by, 3 MSC, 4 DEV, 5–9 keys, 10 PPS SIZE, 11 ACS SIZE, 12 WISDOM SIZE, 13 Used, 14 PPS FOB, 15 ACS FOB, 16 W Final, 17 W Ext, 18 Version, 19 Cost Sheet No, 20 Max Date, 21 Error From, 22 Done, 23 Changed By, 24 Changed On, 25 ACS Match?` = 26.

Body — in the row `return (`, directly after `<td className="row-num">{row.rowIdx}</td>` insert:

```tsx
                {/* Master Data: Team Mer from the master file (labels dimmed), and the
                    Costsheet creator it was looked up from. */}
                <td
                  className={
                    row.merTeams.length === 1 &&
                    (row.merTeams[0] === NO_COSTSHEET || row.merTeams[0] === UNASSIGNED)
                      ? 'cell-empty'
                      : undefined
                  }
                  title={row.merTeams.join(', ')}
                >
                  {row.merTeams.join(', ')}
                </td>
                <td title={row.cCreatedBy}>{row.cCreatedBy || '—'}</td>
```

- [ ] **Step 5: Build**

Run (in `$FE`): `npm run build`
Expected: `tsc -b` clean and `vite build` prints `✓ built in …`.

Re-run the harness (guards against regressions in `lib/`): `node "$SP/verify-mer-team.mjs" "$FE" "$SP"` → `21 passed, 0 failed`.

- [ ] **Step 6: Manual check in the running app**

Start backend (`py serve.py` in `$DB`) and frontend (`npm run dev` in `$FE`), log in, load ACS + PPS + Costsheet, click Validate. Confirm:

1. The table shows a **Master Data** header over **Team Mer** and **Created CBD by**, right after `#`.
2. The Team Mer dropdown lists real teams A→Z, then `(Unassigned)` / `(No Costsheet)` if present.
3. Picking `Team D (X)` shows only rows whose Team Mer contains it; a `dev_carol` row shows `Team D (X), TEAM_B` and also appears under `TEAM_B`.
4. **Clear Filters** resets the team dropdown to "All Team Mer".
5. Typing `dev_alice` in Search finds that creator's rows.
6. Drag-resize **Team Mer**, **Season** and **Max Date** — each drags its own column (index shift is right).
7. Repeat with Costsheet **not** loaded: every row reads `(No Costsheet)`, no layout break.
8. Rename `Data/Master_MerDevTeam.xlsx` temporarily → Validate still shows results, one toast `Team Mer master not loaded: Team Mer master file not found: Master_MerDevTeam.xlsx`, matched rows read `(Unassigned)`. Rename it back.
9. Export CSV: `Team_Mer` and `Created_CBD_By` are columns 2–3.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/csv.ts frontend/src/App.tsx frontend/src/components/ResultsToolbar.tsx frontend/src/components/ResultsTable.tsx frontend/src/styles/tokens.css frontend/src/styles/global.css
git commit -m "feat: Team Mer column group and filter in results"
```

---

### Task 6: Handover doc

**Files:**
- Modify: `docs/HANDOVER.md` (WISDOM side §C, file map §0.1)

- [ ] **Step 1: Update the doc**

In `#### C. WISDOM / Costsheet side`, after the bullet starting `- **5 · Size-filter, then MAX(First Input Date)`, and its sub-bullet, add:

```markdown
- **6 · Team Mer from the winning row's `Created CBD by`** — the same winning row that gives Version / Cost Sheet No. supplies the creator, which `merTeam.ts` looks up in the master from `GET /get_mer_team_master` (`mer_team.py`, reading `Data/Master_MerDevTeam.xlsx`, cached by file mtime). Case/space-insensitive. A dev in several teams belongs to all of them. No Costsheet match → `(No Costsheet)`; blank / unknown creator or master not loaded → `(Unassigned)`.
```

Change the section heading count from `— 5` to `— 6`.

In `### 0.1 Backend`, add a row after `logs_db.py`:

```markdown
| `mer_team.py`          | **Team Mer master** — reads `Data/Master_MerDevTeam.xlsx` (`MER_TEAM`, `MER_DEV`; path override `MER_TEAM_MASTER_PATH`), caches by file mtime, serves `GET /get_mer_team_master`. The `.xlsx` is gitignored: **copy it to the server's `Data/` folder by hand.** |
```

and in the `requirements.txt` row change `Runtime deps: Flask, flask-cors, pyodbc, ldap3, python-dotenv, waitress.` to `Runtime deps: Flask, flask-cors, pyodbc, ldap3, python-dotenv, waitress, openpyxl.`

- [ ] **Step 2: Final verification**

Run (in `$DB`): `py -m pytest -q` → all pass.
Run (in `$FE`): `npm run build` → success.
Run: `git status --short` → confirm no `.xlsx`, `.db`, or scratchpad files are staged or untracked-and-new.

- [ ] **Step 3: Commit**

```bash
git add docs/HANDOVER.md
git commit -m "docs: document Team Mer master data"
```

---

## Deployment notes (for whoever ships it — not a task)

On the server: copy `Data/Master_MerDevTeam.xlsx` into `DashBoard/Data/`, run `py -m pip install -r requirements.txt` (adds `openpyxl`), restart `serve.py`, and replace `frontend/dist` with the new build (delete the old `dist` first — see the Link Watch notes).
