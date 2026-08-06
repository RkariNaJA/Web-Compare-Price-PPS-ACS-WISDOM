# Currency-Aware PPS Row Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop one logical PPS quote from appearing as two output rows when `dbo.PPS` holds it in both USD and THB, and mark non-USD quotes as not-compared instead of reporting them as false Diffs.

**Architecture:** `dbo.PPS` stores the same price once per currency. `FileSlotPPS` strips `LOCAL_CURRENCY`, so `dedupePPSRows` — which keys on the amount by design — cannot tell a currency twin from a genuinely different quote. Fix: keep the column, then collapse to the preferred currency per `(season, style, colour, size)` group *before* the existing dedup, leaving groups with no USD row intact so THB-only quotes survive. A shared `verdictOf` helper then adds a fourth `notCompared` verdict so those rows stop polluting the Diff count.

**Tech Stack:** TypeScript 5 (strict), React 18 + Vite 5. No frontend test framework — verification runs through a Node harness in the session scratchpad that esbuild-bundles the real `lib/` modules.

**Spec:** `docs/superpowers/specs/2026-08-05-pps-currency-aware-row-selection-design.md`

## Global Constraints

- **Do NOT change the `dedupePPSRows` key.** `LOCAL_QUOTE_AMOUNT` stays in it, so the 174 groups with genuinely different USD amounts keep one row per amount. Currency collapsing happens in a separate pass *before* it.
- **Group on the dedup key MINUS the amount** — `SEASON_YEAR | STYLE | COLOR | <sizeCol>` — because the amount is exactly what differs between currency twins.
- **Prefer, never filter.** A group with no `PREFERRED_CURRENCY` row must pass through untouched. 5 real quote groups (styles `STYLE-D`, `STYLE-E`) are THB-only and must not vanish.
- **Never compare a non-preferred-currency quote.** Skip the FOB comparison rather than performing it and failing.
- **Do NOT modify `sql_backend.py`, `dbo.PPS`, or the ACS / Costsheet logic.**
- **Do NOT add a test framework or any new file to the repo.** The harness is scratchpad-only.
- **`'USD'` must be a named constant**, never a literal inside a function.
- **`README.md` and `auth_ad.py` have uncommitted user changes — do not touch either file.**
- **`frontend/src/lib/constants.ts` already has `'LOCAL_CURRENCY'` added by the user, uncommitted.** Keep that line; do not revert or duplicate it.

**Scratchpad path** (`$SP`):
`C:\Users\chayodom.k\AppData\Local\Temp\claude\C--Users-chayodom-k-Desktop-Pyrhon-Refresh-File-PPS-ACS-WISDOM-DashBoard\07caaec2-c5dc-4b59-99d8-b78aab6c1c93\scratchpad`

**Frontend path** (`$FE`):
`C:\Users\chayodom.k\Desktop\Pyrhon Refresh File\PPS,ACS,WISDOM\DashBoard\frontend`

---

## File Structure

| File | Responsibility | Task |
| ---- | -------------- | ---- |
| `lib/constants.ts` | `PREFERRED_CURRENCY`, `STRICT_B_COLS` | 1 |
| `lib/types.ts` | `CompRow.currency`, `CompRow.comparable` | 1 |
| `lib/comparison.ts` | `preferUSDRows`, wiring, `verdictOf`, counts | 1 + 2 |
| `lib/summary.ts` | use shared `verdictOf`, count `notCompared` | 2 |
| `lib/csv.ts` | use shared `verdictOf`, `LOCAL_CURRENCY` column | 2 |
| `components/ResultsTable.tsx` | inline currency, not-compared badge | 3 |
| `components/ResultsToolbar.tsx` | `notcompared` filter + stat pill | 3 |
| `App.tsx` | filter predicate, counts, Validate toast | 3 |
| `$SP/verify-currency.mjs` | harness (**scratchpad only, never committed**) | 1–3 |

**Task 1 alone kills the duplicate** and is shippable on its own. Task 2 fixes the false Diff on the 5 THB-only groups. Task 3 makes it visible.

---

### Task 1: Collapse currency twins before dedup

**Files:**
- Modify: `frontend/src/lib/constants.ts` (`STRICT_B_COLS`, ends ~line 78)
- Modify: `frontend/src/lib/types.ts` (`CompRow`, lines 48-79)
- Modify: `frontend/src/lib/comparison.ts` (imports lines 11-19; new function beside `dedupePPSRows` at 109-136; `CompareResult` 23-30; the `dataBFiles.forEach` body from 197; both `compRows.push` sites; the return at 500)
- Create: `$SP/verify-currency.mjs` (scratchpad)

**Interfaces:**
- Consumes: `dedupePPSRows` (private, unchanged), `PPSFile` / `Row` / `CompRow` from `types.ts`
- Produces: `PREFERRED_CURRENCY` (exported from `constants.ts`); `CompRow.currency: string` and `CompRow.comparable: boolean`; `CompareResult.currencyFilteredRows: number`. Tasks 2 and 3 read all of these.

- [ ] **Step 1: Write the failing harness**

Create `$SP/verify-currency.mjs`. It drives the **real `runComparison`**, so it proves the new pass is actually wired in, not just that the function exists.

```js
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const FE = process.argv[2];
const SP = process.argv[3];
const esbuild = await import(
  pathToFileURL(path.join(FE, 'node_modules', 'esbuild', 'lib', 'main.js')).href
);

async function load(name) {
  const outfile = path.join(SP, `curr-bundle-${name}.mjs`);
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

const cmp = await load('comparison');

// ── ACS fixture: one row that will match every PPS row below ────────────────
const ACS = {
  name: 'acs',
  headers: ['Season','StyleNumber','ColorwayCode','FactoryCode','CBDID','FinalFOB','ExtSzFOB','EXTRACTED_SIZE'],
  rows: [['SU27','STYLE-A','ALL_SOLID','HIT','SU27-HIT-STYLE-A-S-ALL_SOLID-ALL_EXTEND_SIZE-RB','4.00','4.00','ALL_EXTEND_SIZE_RB']],
};

// ── PPS fixture, shaped exactly as FileSlotPPS leaves it ────────────────────
// SIZE_DATA holds the NORMALISED bucket; ORIG_SIZE_DATA holds the raw size.
const B_HDR = ['MSC_CODE','RESPONSIBLE_DEVELOPER','SEASON_YEAR','STYLE','COLOR','FTYCODE',
               'SIZE_DATA','LOCAL_QUOTE_AMOUNT','LOCAL_CURRENCY','INSERT_DATE','ORIG_SIZE_DATA'];

function bRow({ style = 'STYLE-A', size = '4XL', bucket = 'ALL_EXTEND_SIZE_RB',
                amt, cur, ins = '2026-01-01 00:00:00' }) {
  return ['MSC1','DEV NAME','SU27',style,'','HIT',bucket,amt,cur,ins,size];
}
const ppsFile = (rows, headers = B_HDR) => ({ name: 'pps', headers, rows, colorIdx: 0 });
const run = (rows, headers) => cmp.runComparison(ACS, [ppsFile(rows, headers)], null);

// ── T1 the reported bug: USD + THB twins collapse to ONE row ────────────────
let r = run([
  bRow({ amt: '4.00',   cur: 'USD' }),
  bRow({ amt: '124.00', cur: 'THB' }),
]);
check('T1 twins -> 1 row', r.rows.length, 1);
check('T1 the USD row survives', [r.rows[0].localQuoteVal, r.rows[0].currency], ['4.00', 'USD']);
check('T1 survivor is comparable', r.rows[0].comparable, true);
check('T1 currencyFilteredRows counts the THB row', r.currencyFilteredRows, 1);

// ── T2 THB-only group survives, flagged not comparable ──────────────────────
r = run([bRow({ amt: '500.00', cur: 'THB' })]);
check('T2 THB-only -> 1 row', r.rows.length, 1);
check('T2 THB-only kept', [r.rows[0].localQuoteVal, r.rows[0].currency], ['500.00', 'THB']);
check('T2 THB-only not comparable', r.rows[0].comparable, false);
check('T2 nothing filtered', r.currencyFilteredRows, 0);

// ── T3 USD-only unchanged ───────────────────────────────────────────────────
r = run([bRow({ amt: '4.00', cur: 'USD' })]);
check('T3 USD-only -> 1 row', [r.rows.length, r.rows[0].comparable], [1, true]);

// ── T4 two DISTINCT USD amounts still produce two rows (the 174-group case) ─
r = run([
  bRow({ amt: '3.50', cur: 'USD' }),
  bRow({ amt: '4.00', cur: 'USD' }),
]);
check('T4 distinct USD amounts -> 2 rows', r.rows.length, 2);

// ── T5 distinct USD amounts AND THB -> both USD rows, THB dropped ───────────
r = run([
  bRow({ amt: '3.50',   cur: 'USD' }),
  bRow({ amt: '4.00',   cur: 'USD' }),
  bRow({ amt: '124.00', cur: 'THB' }),
]);
check('T5 -> 2 rows', r.rows.length, 2);
check('T5 both USD', r.rows.map((x) => x.currency), ['USD', 'USD']);

// ── T6 different SIZES are independent groups ───────────────────────────────
r = run([
  bRow({ size: '4XL', amt: '4.00',   cur: 'USD' }),
  bRow({ size: '4XL', amt: '124.00', cur: 'THB' }),
  bRow({ size: '5XL', amt: '4.00',   cur: 'USD' }),
  bRow({ size: '5XL', amt: '124.00', cur: 'THB' }),
]);
check('T6 two sizes -> 2 rows', r.rows.length, 2);
check('T6 both USD', r.rows.map((x) => x.currency), ['USD', 'USD']);

// ── T7 no LOCAL_CURRENCY column (uploaded spreadsheet) -> untouched ─────────
const NO_CUR = B_HDR.filter((h) => h !== 'LOCAL_CURRENCY');
const stripCur = (row) => row.filter((_, i) => B_HDR[i] !== 'LOCAL_CURRENCY');
r = run([stripCur(bRow({ amt: '4.00', cur: 'USD' })),
         stripCur(bRow({ amt: '124.00', cur: 'THB' }))], NO_CUR);
check('T7 no currency column -> both rows kept', r.rows.length, 2);
check('T7 all comparable', r.rows.map((x) => x.comparable), [true, true]);
check('T7 currency blank', r.rows.map((x) => x.currency), ['', '']);

// ── T8 casing / padding tolerated ───────────────────────────────────────────
r = run([
  bRow({ amt: '4.00',   cur: ' usd ' }),
  bRow({ amt: '124.00', cur: 'thb' }),
]);
check('T8 padded lowercase usd wins', r.rows.length, 1);
check('T8 comparable', r.rows[0].comparable, true);

// ── T9 exact duplicate USD rows still collapse via dedupePPSRows ────────────
r = run([
  bRow({ amt: '4.00', cur: 'USD' }),
  bRow({ amt: '4.00', cur: 'USD' }),
  bRow({ amt: '4.00', cur: 'USD' }),
  bRow({ amt: '4.00', cur: 'USD' }),
]);
check('T9 identical USD rows -> 1 row', r.rows.length, 1);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
console.log('ALL GREEN');
```

- [ ] **Step 2: Run the harness to verify it fails**

```bash
SP="C:/Users/chayodom.k/AppData/Local/Temp/claude/C--Users-chayodom-k-Desktop-Pyrhon-Refresh-File-PPS-ACS-WISDOM-DashBoard/07caaec2-c5dc-4b59-99d8-b78aab6c1c93/scratchpad"; \
node "$SP/verify-currency.mjs" "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend" "$SP"
```

Expected: FAIL. `T1 twins -> 1 row` reports `actual 2`, every `currency` / `comparable` assertion reports `actual undefined`, and `currencyFilteredRows` reports `actual undefined`. `T3`, `T4`, `T7` (row counts), and `T9` should already pass — they encode existing behaviour that must not regress.

- [ ] **Step 3: Add the constant and keep `INSERT_DATE`**

In `frontend/src/lib/constants.ts`, above `STRICT_B_COLS`:

```ts
// Currency the validator compares in. PPS quotes in any other currency are kept but not
// compared, because the ACS and Costsheet FOBs are all in this currency. Promote to a
// user-facing setting when real multi-currency support arrives.
export const PREFERRED_CURRENCY = 'USD';
```

Then add `'INSERT_DATE'` to `STRICT_B_COLS`. `'LOCAL_CURRENCY'` is **already there** (uncommitted user edit) — leave it. The result must read:

```ts
  'LOCAL_QUOTE_AMOUNT',
  'LOCAL_CURRENCY',   // tells a currency twin from a genuinely different quote
  'INSERT_DATE',      // makes dedupePPSRows' newest-wins tie-break actually run
];
```

> `INSERT_DATE` changes no output today — `dedupePPSRows` only uses it to break ties between rows with an *identical* amount, and no such rows differ in any displayed field. It is added because `comparison.ts:116` already looks for it and the comment at `:118-119` already claims the behaviour.

- [ ] **Step 4: Add the two `CompRow` fields**

In `frontend/src/lib/types.ts`, inside `CompRow` directly after `localQuoteVal` (line 60):

```ts
  localQuoteVal: string;       // PPS LOCAL_QUOTE_AMOUNT
  currency: string;            // raw LOCAL_CURRENCY ('' when the source has no such column)
  comparable: boolean;         // false = non-preferred currency, so the FOB comparison is skipped
```

- [ ] **Step 5: Add `preferUSDRows` and wire it in**

In `frontend/src/lib/comparison.ts`:

**(a)** Add `PREFERRED_CURRENCY` to the `./constants` import (line 12).

**(b)** Add `currencyFilteredRows` to `CompareResult` (after `collapsedRows`, line 29):

```ts
  collapsedRows: number;         // raw PPS rows merged away by de-duplication (0 if none)
  currencyFilteredRows: number;  // rows dropped because the group also had a PREFERRED_CURRENCY quote
```

**(c)** Insert this function immediately **before** `dedupePPSRows` (line 109):

```ts
// dbo.PPS quotes the same price once per currency (USD and THB today), so one logical
// quote arrives as two rows with different LOCAL_QUOTE_AMOUNTs — 4.00 USD and 124.00 THB
// are the same price at a ~31 rate. Collapse each (season, style, color, size) group to
// the preferred currency. The amount is deliberately NOT part of the group key: it is the
// very thing that differs between twins.
//
// Groups with NO preferred-currency row pass through untouched, so a THB-only quote still
// reaches the table (flagged non-comparable via CompRow.comparable). Returns the rows
// unchanged when LOCAL_CURRENCY is absent — an uploaded spreadsheet has no such column.
// Runs BEFORE dedupePPSRows, which still keys on the amount and so still keeps genuinely
// different quotes apart.
function preferUSDRows(fileB: PPSFile): Row[] {
  const h = fileB.headers;
  const curIdx = h.indexOf('LOCAL_CURRENCY');
  if (curIdx === -1) return fileB.rows;
  const sizeCol = h.indexOf('ORIG_SIZE_DATA') !== -1 ? 'ORIG_SIZE_DATA' : 'SIZE_DATA';
  const groupIdx = ['SEASON_YEAR', 'STYLE', 'COLOR', sizeCol].map((c) => h.indexOf(c));
  if (groupIdx.some((i) => i === -1)) return fileB.rows;

  const groupOf = (row: Row) =>
    groupIdx.map((i) => String(row[i] ?? '').trim().toLowerCase()).join('|');
  const isPreferred = (row: Row) =>
    String(row[curIdx] ?? '').trim().toUpperCase() === PREFERRED_CURRENCY;

  const groupsWithPreferred = new Set<string>();
  for (const row of fileB.rows) if (isPreferred(row)) groupsWithPreferred.add(groupOf(row));

  return fileB.rows.filter((row) => !groupsWithPreferred.has(groupOf(row)) || isPreferred(row));
}
```

**(d)** Declare the counter beside `rawPPSRows` (line 195):

```ts
  let rawPPSRows = 0; // total PPS rows across processed files BEFORE de-duplication
  let currencyFilteredRows = 0; // rows dropped by preferUSDRows
```

**(e)** Replace the dedupe call (lines 217-218) so the currency pass runs first:

```ts
    rawPPSRows += fileB.rows.length;
    // Collapse currency twins first, then the quote-history duplicates.
    const preferredRows = preferUSDRows(fileB);
    currencyFilteredRows += fileB.rows.length - preferredRows.length;
    const dedupedRows = dedupePPSRows({ ...fileB, rows: preferredRows });
```

**(f)** Resolve the currency per row. Add beside the other header lookups in the `dataBFiles.forEach` body (near `localQuoteIdx`, line 199):

```ts
    const currencyIdx = bHdr.indexOf('LOCAL_CURRENCY');
```

and inside `dedupedRows.forEach`, next to `localQuoteVal` (line 291):

```ts
      // Raw value so the table shows exactly what the DB holds; the comparable check
      // normalises the same way preferUSDRows does, so ' usd ' is not kept-then-flagged.
      const currency = currencyIdx !== -1 ? String(rowB[currencyIdx] ?? '').trim() : '';
      const comparable = currency === '' || currency.toUpperCase() === PREFERRED_CURRENCY;
```

**(g)** Add `currency,` and `comparable,` to **both** `compRows.push({...})` object literals (the happy path ~line 390 and the `noKeyMatch` path ~line 460), beside `localQuoteVal`.

**(h)** Add `currencyFilteredRows` to the returned object (line 500):

```ts
  return { rows: compRows, matchCount, diffCount, noKeyCount, warnings, collapsedRows, currencyFilteredRows };
```

> Do NOT change the verdict counts or skip any comparison in this task — that is Task 2. After this task the 5 THB-only rows still read as Diff; the duplicate is gone.

- [ ] **Step 6: Run the harness to verify it passes**

Same command as Step 2. Expected: `ALL GREEN`, 0 failed.

- [ ] **Step 7: Verify the build**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend"
npm run build
```

Expected: `tsc -b` clean. If it reports `currency`/`comparable` missing on an object literal, a `compRows.push` site was missed in step (g).

- [ ] **Step 8: Commit**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/lib/constants.ts frontend/src/lib/types.ts frontend/src/lib/comparison.ts
git commit -F - <<'EOF'
Collapse PPS currency twins before de-duplication

dbo.PPS stores the same quote once per currency, so STYLE-A/SU27/HIT/4XL
arrived as two rows: 4.00 USD and 124.00 THB, the same price at a ~31 rate.
FileSlotPPS stripped LOCAL_CURRENCY, so dedupePPSRows -- which keys on the
amount by design -- could not tell a twin from a genuinely different quote.

preferUSDRows now collapses each (season, style, color, size) group to the
preferred currency before the existing dedup. Groups with no USD row pass
through untouched so the 5 THB-only quote groups still reach the table,
flagged via the new CompRow.comparable.

INSERT_DATE joins STRICT_B_COLS too: dedupePPSRows intends a newest-wins
tie-break but the column was already stripped, leaving the branch dead. It
changes no output today.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: One shared verdict, with a `notCompared` state

**Files:**
- Modify: `frontend/src/lib/comparison.ts` (new exported `verdictOf`; skip comparisons when not comparable; counts at 493-495)
- Modify: `frontend/src/lib/summary.ts` (`VerdictCounts` 11-16, `blank()` 36, local `verdictOf` 33-34, `bump` 37-40)
- Modify: `frontend/src/lib/csv.ts` (local `verdict` 20-23, `diffReason` 27-34, `hdr` 47-69, row body 71-94)
- Modify: `$SP/verify-currency.mjs`

**Interfaces:**
- Consumes: `CompRow.comparable` (Task 1)
- Produces: `export type Verdict = 'match' | 'diff' | 'noKey' | 'notCompared'` and `export function verdictOf(r: CompRow): Verdict`, both from `comparison.ts`; `CompareResult.notComparedCount`. Task 3 uses both.

> **Why a shared helper:** the same verdict derivation is currently copied in four places — `comparison.ts:493-495`, `summary.ts:33-34`, `csv.ts:20-23`, and `App.tsx:177-179`/`224-226`. A fourth state cannot be added consistently while that logic is duplicated. No import cycle results: `comparison.ts` imports only `types` / `constants` / `normalize` / `costsheet`.

- [ ] **Step 1: Write the failing test**

Append to `$SP/verify-currency.mjs`, before the summary block:

```js
// ── T10 verdictOf covers all four states ───────────────────────────────────
const sum = await load('summary');
const mkRow = (o) => ({ status: 'matched', valueMatch: false, comparable: true,
                        keys: [{ aName: 'Season', bVal: 'SU27' }, { aName: 'FactoryCode', bVal: 'HIT' }], ...o });
check('T10 match',        cmp.verdictOf(mkRow({ valueMatch: true })), 'match');
check('T10 diff',         cmp.verdictOf(mkRow({})), 'diff');
check('T10 noKey',        cmp.verdictOf(mkRow({ status: 'noKeyMatch' })), 'noKey');
check('T10 notCompared',  cmp.verdictOf(mkRow({ comparable: false })), 'notCompared');
// noKey wins over notCompared: no ACS row is a key problem regardless of currency.
check('T10 noKey beats notCompared',
  cmp.verdictOf(mkRow({ status: 'noKeyMatch', comparable: false })), 'noKey');

// ── T11 a non-comparable row is NOT counted as a Diff ──────────────────────
r = run([bRow({ amt: '500.00', cur: 'THB' })]);
check('T11 diffCount excludes it', r.diffCount, 0);
check('T11 counted separately', r.notComparedCount, 1);
check('T11 no comparison performed', [r.rows[0].valueMatch, r.rows[0].lqVsAcs, r.rows[0].cMatch],
  [false, false, null]);

// ── T12 a comparable USD row that matches still counts as a Match ───────────
r = run([bRow({ amt: '4.00', cur: 'USD' })]);
check('T12 match counted', [r.matchCount, r.diffCount, r.notComparedCount], [1, 0, 0]);

// ── T13 summarize() agrees with verdictOf ───────────────────────────────────
r = run([
  bRow({ size: '4XL', amt: '4.00',   cur: 'USD' }),
  bRow({ size: '5XL', amt: '500.00', cur: 'THB' }),
]);
const s = sum.summarize(r.rows);
check('T13 totals', [s.totals.match, s.totals.diff, s.totals.notCompared, s.totals.total],
  [1, 0, 1, 2]);
```

- [ ] **Step 2: Run the harness to verify it fails**

Same command as Task 1 Step 2.
Expected: FAIL on every `T10` assertion (`cmp.verdictOf` is not a function — the harness will throw, which counts as failure), plus `T11`/`T13`. Tasks 1's `T1`–`T9` must still pass.

If the throw stops the run before later assertions, that is acceptable for Step 2 — the fix makes the whole file run.

- [ ] **Step 3: Implement the shared verdict**

**(a)** In `frontend/src/lib/comparison.ts`, export the type and helper near the top (after the `CompareResult` interface, line 30):

```ts
// The row's verdict, derived in ONE place. Previously this same expression lived in
// comparison.ts, summary.ts, csv.ts and App.tsx, which is why a fourth state could not be
// added consistently. noKey is checked first: a row with no ACS match is a key problem
// regardless of what currency it was quoted in.
export type Verdict = 'match' | 'diff' | 'noKey' | 'notCompared';

export function verdictOf(r: CompRow): Verdict {
  if (r.status === 'noKeyMatch') return 'noKey';
  if (!r.comparable) return 'notCompared';
  return r.valueMatch ? 'match' : 'diff';
}
```

**(b)** Add `notComparedCount: number;` to `CompareResult` and skip the comparisons for non-comparable rows. In the happy path, replace the `lqVsAcs` / `acsMatch` computation so a non-comparable row is never compared:

```ts
        // A quote in a non-preferred currency is not comparable against a USD FOB, so no
        // comparison is performed at all — see verdictOf / CompRow.comparable.
        const lqVsAcs = !comparable
          ? false
          : !isNaN(numL) && !isNaN(numF)
            ? Math.abs(numL - numF) < 0.0001
            : localQuoteVal.toLowerCase() === dbFobValue.toLowerCase();
```

and guard the Costsheet comparison so `cMatch` stays `null`:

```ts
        if (comparable && cResult && cResult.matched) {
```

**(c)** Replace the tallies (lines 493-495) with the shared helper:

```ts
  const matchCount = compRows.filter((r) => verdictOf(r) === 'match').length;
  const diffCount = compRows.filter((r) => verdictOf(r) === 'diff').length;
  const noKeyCount = compRows.filter((r) => verdictOf(r) === 'noKey').length;
  const notComparedCount = compRows.filter((r) => verdictOf(r) === 'notCompared').length;
```

and add `notComparedCount` to the returned object.

**(d)** In `frontend/src/lib/summary.ts`: delete the local `verdictOf` (lines 33-34), import the shared one (`import { verdictOf } from './comparison';`), add `notCompared: number` to `VerdictCounts`, `notCompared: 0` to `blank()`, and widen `bump`'s second parameter to the imported `Verdict` type.

**(e)** In `frontend/src/lib/csv.ts`: delete the local `verdict` (lines 20-23) and map the shared verdict to the export strings:

```ts
import { verdictOf } from './comparison';

const VERDICT_CSV = {
  match: 'MATCH', diff: 'DIFF', noKey: 'NO_KEY_MATCH', notCompared: 'NOT_COMPARED',
} as const;
```

Use `VERDICT_CSV[verdictOf(r)]` at the call site (line 88). Add `'LOCAL_CURRENCY'` to `hdr` directly after `'LOCAL_QUOTE_AMOUNT'` (line 60) and `r.currency` to the row body after `r.localQuoteVal` (line 83). Make `diffReason` return `''` for non-comparable rows by changing its guard (line 28):

```ts
  if (r.status !== 'matched' || r.valueMatch || !r.comparable) return '';
```

- [ ] **Step 4: Run the harness to verify it passes**

Same command. Expected: `ALL GREEN`, 0 failed — Tasks 1 and 2 assertions together.

- [ ] **Step 5: Verify the build**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend"
npm run build
```

Expected: clean. `App.tsx` still has its own inline verdict logic at this point and will keep compiling — Task 3 migrates it.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/lib/comparison.ts frontend/src/lib/summary.ts frontend/src/lib/csv.ts
git commit -F - <<'EOF'
Add notCompared verdict and share one verdictOf helper

Non-USD PPS quotes were compared against USD ACS FOBs and so always read as
a Diff, inflating the Diff count. They now resolve to a fourth verdict,
notCompared, and their FOB comparisons are skipped rather than performed and
failed.

The verdict derivation was duplicated in comparison.ts, summary.ts, csv.ts
and App.tsx, which is why a fourth state could not be added consistently.
It now lives once in comparison.ts as verdictOf(); summary and csv import it.
The CSV export also gains a LOCAL_CURRENCY column.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Surface it in the UI

**Files:**
- Modify: `frontend/src/App.tsx` (filter predicate 175-180, counts 224-226, Validate toast 155-160)
- Modify: `frontend/src/components/ResultsToolbar.tsx` (`FilterCategory` 21, `Props` 23-48, stat pills 103-117, filter buttons 191-204)
- Modify: `frontend/src/components/ResultsTable.tsx` (PPS FOB cell, verdict badge)
- Modify: `frontend/src/components/FileSlotPPS.tsx` (preview header filter, line 125)
- Modify: `$SP/verify-currency.mjs`

**Also fix a side effect Task 1 introduced.** Adding `INSERT_DATE` to `STRICT_B_COLS` made it a kept column, and `FileSlotPPS.tsx:125` filters only `ORIG_SIZE_DATA` out of the preview — so a raw `datetime2` column now appears in the on-screen PPS preview. It is an internal column like `ORIG_SIZE_DATA` and should be hidden the same way:

```ts
    const headers = files[0].headers.filter(
      (h) => h !== 'ORIG_SIZE_DATA' && h !== 'INSERT_DATE',
    );
```

Keep `LOCAL_CURRENCY` visible in the preview — unlike `INSERT_DATE` it is information the user wants.

**Also correct one stale comment.** `summary.ts:6-7` says the verdict mapping is "identical to the results toolbar" and lists only three states. That claim is false between Tasks 2 and 3; this task makes it true again, so update it to name all four states. This is the only edit permitted in `summary.ts` here.

**Interfaces:**
- Consumes: `verdictOf`, `Verdict`, `CompareResult.notComparedCount`, `CompareResult.currencyFilteredRows`, `CompRow.currency`
- Produces: no new exports.

> **Deliberately NOT adding a table column.** `ResultsTable` tracks leaf columns by hardcoded index — `colCount = hasC ? 23 : 18` (`:64`), the `ci` map (`:119-122`), and `resizer(n)` calls numbered 1-17 plus `colCount-5…-1`. Inserting a column means renumbering all of it, and the guard at `:77` (`firstRow.cells.length !== colCount`) fails *soft*: get it wrong and column resizing silently stops working with no error. The currency is rendered **inline in the existing PPS FOB cell** instead. The CSV (Task 2) has the real column, where there is no such cost.

- [ ] **Step 1: Write the failing test**

Append to `$SP/verify-currency.mjs`, before the summary block. This task is mostly React, so the harness covers only the pure part — the toolbar's category list must stay in step with the `Verdict` type:

```js
// ── T14 every Verdict has a filter category (guards the union drifting) ────
r = run([
  bRow({ size: '4XL', amt: '4.00',   cur: 'USD' }),
  bRow({ size: '5XL', amt: '500.00', cur: 'THB' }),
]);
const seen = new Set(r.rows.map((x) => cmp.verdictOf(x)));
check('T14 both verdicts present', [...seen].sort(), ['match', 'notCompared']);
check('T14 counts line up',
  [r.matchCount, r.diffCount, r.noKeyCount, r.notComparedCount], [1, 0, 0, 1]);
check('T14 currencyFilteredRows still reported', typeof r.currencyFilteredRows, 'number');
```

- [ ] **Step 2: Run the harness to verify it fails**

Same command. Expected: `T14` fails only if Task 2 regressed; otherwise it passes immediately — this task's real verification is Step 5 (manual UI check), because the change is React rendering. State that plainly in your report rather than implying the harness proves the UI.

- [ ] **Step 3: Implement `App.tsx`**

Replace the inline verdict logic with the shared helper.

Import `verdictOf` and `type Verdict` from `./lib/comparison`, and `PREFERRED_CURRENCY` from
`./lib/constants`.

`verdictOf` returns camelCase (`noKey`, `notCompared`) while `FilterCategory` is lowercase
(`nokey`, `notcompared`), so a cast would silently fail for exactly those two. Use an explicit
map — declare it at module scope:

```ts
const VERDICT_TO_CATEGORY: Record<Verdict, FilterCategory> = {
  match: 'match', diff: 'diff', noKey: 'nokey', notCompared: 'notcompared',
};
```

Filter predicate (lines 175-180) becomes:

```ts
    if (activeFilters.size > 0) {
      out = out.filter((r) => activeFilters.has(VERDICT_TO_CATEGORY[verdictOf(r)]));
    }
```

Counts (lines 224-226):

```ts
  const matchCount = filtered.filter((r) => verdictOf(r) === 'match').length;
  const diffCount = filtered.filter((r) => verdictOf(r) === 'diff').length;
  const noKeyCount = filtered.filter((r) => verdictOf(r) === 'noKey').length;
  const notComparedCount = filtered.filter((r) => verdictOf(r) === 'notCompared').length;
```

Pass `notComparedCount` to `ResultsToolbar`, and extend the Validate toast so currency filtering is reported separately from de-duplication.

> **`currencyFilteredRows` is CONTAINED IN `collapsedRows`, not disjoint from it.** `collapsedRows` is `rawPPSRows - compRows.length` (`comparison.ts`) and `rawPPSRows` is summed **before** the currency pass, so every currency-dropped row is also counted as a collapsed duplicate. `App.tsx:155-158` renders that total as *"duplicate rows collapsed"*. Naively appending a second note would report the same rows twice. Subtract:

```ts
    const dupOnly = result.collapsedRows - result.currencyFilteredRows;
    const dupNote =
      dupOnly > 0 ? ` · ${dupOnly.toLocaleString()} duplicate rows collapsed` : '';
    const curNote = result.currencyFilteredRows
      ? ` · ${result.currencyFilteredRows.toLocaleString()} non-${PREFERRED_CURRENCY} rows excluded`
      : '';
    const ncNote = result.notComparedCount
      ? ` · ${result.notComparedCount.toLocaleString()} not compared`
      : '';
```

Replace the existing `dupNote` block (`App.tsx:155-158`) with the three above and append all three to the toast string at `:160`.

- [ ] **Step 4: Implement the two components**

`ResultsToolbar.tsx`:

```ts
export type FilterCategory = 'match' | 'diff' | 'nokey' | 'notcompared';
```

Add `notComparedCount: number;` to `Props` and destructure it. Add a fourth stat pill after "No Key" (line 114), shown only when non-zero so the toolbar does not grow for the USD-only case:

```tsx
      {notComparedCount > 0 && (
        <div className="stat-pill" title="Quoted in a currency the validator does not compare">
          <span className="dot" style={{ background: 'var(--c-2)' }} /> Not Compared{' '}
          <span>{notComparedCount}</span>
        </div>
      )}
```

Extend the button list (line 191):

```tsx
        {(['match', 'diff', 'nokey', 'notcompared'] as FilterCategory[]).map((c) => {
          const active = activeFilters.has(c);
          const label =
            c === 'match' ? 'Match' : c === 'diff' ? 'Diff' : c === 'nokey' ? 'No Key' : 'Not Compared';
```

`ResultsTable.tsx` — **read lines 400-440 before editing** (the FOB / Costsheet value cells) and the sticky-end verdict cell near the end of the `shown.map` body. Follow the exact JSX and class conventions already used there; the two changes are:

- **PPS FOB value cell** (the `<td>` rendering `row.localQuoteVal`, in the 405-420 region): append the currency when it is present and not the preferred one, as a muted qualifier rather than part of the number:

  ```tsx
  {row.localQuoteVal}
  {row.currency && row.currency.toUpperCase() !== PREFERRED_CURRENCY && (
    <span style={{ opacity: 0.6, marginLeft: 4, fontSize: '.85em' }}>{row.currency}</span>
  )}
  ```

- **Verdict badge** (the sticky-end cell): add a branch for `verdictOf(row) === 'notCompared'` that renders a **non-red** badge reading `— not compared`, with a `title` explaining the row is quoted in a currency the validator does not compare. Reuse the existing neutral/`--only` badge class rather than the red Diff class, and place the check **before** the Match/Diff branch so it cannot fall through to Diff.

- **Leave `colCount` (`:64`), the `ci` map (`:119-122`), and every `resizer(n)` index untouched.** No column is being added; if `colCount` changes, column resizing silently breaks (the guard at `:77` fails soft).

- [ ] **Step 5: Verify build, harness, and the UI**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend"
npm run build
```

Then re-run the harness (all assertions green) and the backend suite:

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
python -m pytest tests/ -q
```

Expected: 37 passed (no backend change; any failure is pre-existing — report, do not fix).

**Report honestly that the rendered UI was not visually verified** unless you actually ran the app. The harness does not cover React output.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/App.tsx frontend/src/components/ResultsToolbar.tsx frontend/src/components/ResultsTable.tsx
git commit -F - <<'EOF'
Surface non-compared currency rows in the results UI

Adds a "Not Compared" stat pill and filter category, renders the currency
inline in the PPS FOB cell for non-USD quotes, and gives those rows their own
badge instead of the red Diff styling. The Validate toast now reports
currency-excluded rows separately from de-duplicated ones, which previously
inflated the "collapsed" count.

App.tsx now derives its verdict from the shared verdictOf via an explicit
Verdict -> FilterCategory map, replacing the fourth copy of that logic.

No table column was added: ResultsTable indexes leaf columns by hardcoded
number and its width guard fails soft, so the currency is rendered inline.
The CSV export carries the real LOCAL_CURRENCY column.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Done when

- The harness prints `ALL GREEN` (T1–T14).
- `npm run build` compiles clean.
- `python -m pytest tests/ -q` still reports 37 passed.
- `STYLE-A` / `SU27` / `HIT` / `4XL` shows **one** row at 4.00 USD.
- The 5 THB-only groups (`STYLE-D`, `STYLE-E`) still appear, marked not compared, and are absent from the Diff count.
- The 174 multi-USD-amount groups still show one row per distinct amount.
- No new files in the repo; `README.md` and `auth_ad.py` untouched.

## Out of scope (spec follow-ups)

- README's PPS de-duplication section needs the currency rule and `PREFERRED_CURRENCY`.
- Real THB support (conversion or per-currency validation). `PREFERRED_CURRENCY` is the seam.
- `sql_backend.py:395` has no `ORDER BY`, so PPS row order is not guaranteed stable. Harmless today (no dedup key has conflicting display fields) but it makes first-seen-wins non-deterministic in principle.
- Annotations saved against THB rows become inert once those rows stop being emitted. Deliberately left in place rather than deleted.
