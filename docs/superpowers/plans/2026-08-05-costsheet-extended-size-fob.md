# Costsheet Extended-Size FOB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source the **WISDOM Final FOB** column from the Costsheet view's `Extended Size FOB` column (instead of `Final FOB`) whenever the Costsheet row's size is an extended size.

**Architecture:** Three pure-TypeScript files change in `frontend/src/lib/`. A new Costsheet-only size resolver checks `EXTEND_SIZE` before `REG_SIZES` (so `4X` and `48`, which appear in both lists, resolve as extended for Costsheet only). `buildCostsheetIndex` then picks the FOB source per row at index-build time, so nothing downstream needs to know which column won. No backend, no React, no UI changes.

**Tech Stack:** TypeScript 5 (strict), React 18 + Vite 5 (build only — no component changes). No test framework exists in the frontend; verification runs through a scratchpad Node harness that esbuild-bundles the real `lib/` modules.

**Spec:** `docs/superpowers/specs/2026-08-05-costsheet-extended-size-fob-design.md`

## Global Constraints

- **Do NOT edit `REG_SIZES` or `EXTEND_SIZE`** in `constants.ts`. They are shared with `FileSlotPPS.tsx:51`, which rewrites every uploaded PPS row's `SIZE_DATA`; editing them would move PPS bucketing and ACS row matching.
- **Do NOT modify `normalizeSizeToken`.** PPS and ACS keep calling it unchanged.
- **Do NOT modify any file outside `frontend/src/lib/`.** No backend, no components. `sql_backend.py` already does `SELECT *`, so `Extended Size FOB` is present in the headers the frontend receives.
- **Do NOT add a test framework or any new file to the repo.** The verification harness lives in the session scratchpad only.
- **The Costsheet row's own size decides the FOB source** — never the PPS row's size.
- **The empty-FOB → No CS rule applies to extended rows ONLY.** A regular-size row with an empty `Final FOB` keeps today's behaviour (renders `—`, counts as a Diff). This change must be strictly additive: no row that works today may change verdict.
- **The MAX(First Input Date) winner rule is unchanged.** If the newest extended row has an empty `Extended Size FOB`, report No CS — do not fall back to an older row.

**Scratchpad path** (referred to below as `$SP`):
`C:\Users\chayodom.k\AppData\Local\Temp\claude\C--Users-chayodom-k-Desktop-Pyrhon-Refresh-File-PPS-ACS-WISDOM-DashBoard\07caaec2-c5dc-4b59-99d8-b78aab6c1c93\scratchpad`

**Frontend path** (referred to as `$FE`):
`C:\Users\chayodom.k\Desktop\Pyrhon Refresh File\PPS,ACS,WISDOM\DashBoard\frontend`

---

## File Structure

| File | Responsibility | Change |
| ---- | -------------- | ------ |
| `frontend/src/lib/constants.ts` | Column-name config | Add `extFob` to `C_KEY_MAP` + `C_KEY_ALIASES` |
| `frontend/src/lib/normalize.ts` | Atomic pure helpers | Add `normalizeCostsheetSizeToken` |
| `frontend/src/lib/costsheet.ts` | Costsheet index + lookup | Resolve `extFob` column; pick FOB source per row; treat empty ext FOB as unmatched |
| `$SP/verify-ext-fob.mjs` | Verification harness (**scratchpad only, never committed**) | Created in Task 1, extended in Tasks 2–3 |

Task order matters: Task 1 builds the harness and the size resolver, Task 2 adds column resolution, Task 3 wires them together. Each task ends green and committed.

---

### Task 1: Costsheet-only size resolver + verification harness

**Files:**
- Create: `$SP/verify-ext-fob.mjs` (scratchpad — NOT in the repo)
- Modify: `frontend/src/lib/normalize.ts` (append after `normalizeSizeToken`, currently ends line 46)

**Interfaces:**
- Consumes: `convertBSize`, `convertBExtendSize` (already exported from `normalize.ts:29,35`)
- Produces: `normalizeCostsheetSizeToken(raw: unknown): string` — returns `'ALL_EXTEND_SIZE_RB'`, `'ALL_REG_SIZE_RB'`, or the trimmed input unchanged. Task 3 imports this.

- [ ] **Step 1: Write the failing test harness**

Create `$SP/verify-ext-fob.mjs`. It esbuild-bundles the real `lib/` modules (Node cannot import them directly — the internal `./constants` imports are extensionless and only Vite resolves those).

```js
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const FE = process.argv[2];   // absolute path to frontend/
const SP = process.argv[3];   // absolute path to scratchpad/

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
  if (a === e) { pass++; } else { failures.push(`${label}\n     expected ${e}\n     actual   ${a}`); }
}

const norm = await load('normalize');
const consts = await load('constants');

// ── T1.1 all 31 EXTEND_SIZE values resolve to ALL_EXTEND_SIZE_RB ────────────
for (const s of consts.EXTEND_SIZE) {
  check(`T1.1 normalizeCostsheetSizeToken(${s})`, norm.normalizeCostsheetSizeToken(s), 'ALL_EXTEND_SIZE_RB');
}

// ── T1.2 the two overlap values specifically (the regression this fixes) ────
check('T1.2 costsheet 4X', norm.normalizeCostsheetSizeToken('4X'), 'ALL_EXTEND_SIZE_RB');
check('T1.2 costsheet 48', norm.normalizeCostsheetSizeToken('48'), 'ALL_EXTEND_SIZE_RB');

// ── T1.3 regular sizes are untouched ────────────────────────────────────────
for (const s of ['S', 'M', 'L', 'XL', '40', '46R', '3-6', '1SIZE']) {
  check(`T1.3 costsheet ${s}`, norm.normalizeCostsheetSizeToken(s), 'ALL_REG_SIZE_RB');
}

// ── T1.4 PPS/ACS path unchanged: normalizeSizeToken still says REG for 4X/48 ─
check('T1.4 shared 4X unchanged', norm.normalizeSizeToken('4X'), 'ALL_REG_SIZE_RB');
check('T1.4 shared 48 unchanged', norm.normalizeSizeToken('48'), 'ALL_REG_SIZE_RB');
check('T1.4 shared 3XL unchanged', norm.normalizeSizeToken('3XL'), 'ALL_EXTEND_SIZE_RB');
check('T1.4 shared S unchanged', norm.normalizeSizeToken('S'), 'ALL_REG_SIZE_RB');

// ── T1.5 unknown sizes pass through; empty falls back to REG ────────────────
check('T1.5 unknown passthrough', norm.normalizeCostsheetSizeToken('WEIRD-99'), 'WEIRD-99');
check('T1.5 empty -> REG', norm.normalizeCostsheetSizeToken(''), 'ALL_REG_SIZE_RB');

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
console.log('ALL GREEN');
```

- [ ] **Step 2: Run the harness to verify it fails**

```bash
SP="C:/Users/chayodom.k/AppData/Local/Temp/claude/C--Users-chayodom-k-Desktop-Pyrhon-Refresh-File-PPS-ACS-WISDOM-DashBoard/07caaec2-c5dc-4b59-99d8-b78aab6c1c93/scratchpad"; \
node "$SP/verify-ext-fob.mjs" "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend" "$SP"
```

Expected: FAIL. Every `normalizeCostsheetSizeToken` assertion reports `actual undefined` because the function does not exist yet. The four `T1.4` assertions should already PASS (they test existing behaviour).

- [ ] **Step 3: Implement `normalizeCostsheetSizeToken`**

Append to `frontend/src/lib/normalize.ts`, directly after `normalizeSizeToken` (which ends at line 46):

```ts
// Costsheet-only size normalisation. Identical to normalizeSizeToken EXCEPT that
// EXTEND_SIZE is checked FIRST. '4X' and '48' are the only two values present in
// both lists, so they resolve to ALL_EXTEND_SIZE_RB here while PPS/ACS keep
// treating them as regular sizes via normalizeSizeToken. Kept separate on purpose:
// normalizeSizeToken is shared with FileSlotPPS, which rewrites every uploaded PPS
// row's SIZE_DATA, so changing it would move PPS bucketing and ACS row matching.
export function normalizeCostsheetSizeToken(raw: unknown): string {
  let s = convertBExtendSize(String(raw).trim());
  if (s !== 'ALL_EXTEND_SIZE_RB') s = convertBSize(s);
  return s || 'ALL_REG_SIZE_RB';
}
```

- [ ] **Step 4: Run the harness to verify it passes**

Same command as Step 2. Expected: `ALL GREEN`, 0 failed.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/lib/normalize.ts
git commit -F - <<'EOF'
Add Costsheet-only size resolver

normalizeCostsheetSizeToken checks EXTEND_SIZE before REG_SIZES, so 4X and
48 (the only two values in both lists) resolve to ALL_EXTEND_SIZE_RB for
Costsheet rows. normalizeSizeToken is untouched, so PPS and ACS keep
treating them as regular sizes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Resolve the `Extended Size FOB` column

**Files:**
- Modify: `frontend/src/lib/constants.ts:36-46` (`C_KEY_MAP`) and `:51-61` (`C_KEY_ALIASES`)
- Modify: `$SP/verify-ext-fob.mjs` (append a new block before the summary `console.log`)

**Interfaces:**
- Consumes: `findCostsheetIdx(hdr: string[], key: keyof typeof C_KEY_MAP): number` (`normalize.ts:82`)
- Produces: `C_KEY_MAP.extFob === 'Extended Size FOB'`, and `findCostsheetIdx(hdr, 'extFob')` resolving that column. Task 3 calls it.

> **Why this compiles only if both are edited:** `C_KEY_ALIASES` is typed `Record<keyof typeof C_KEY_MAP, string[]>`. Adding `extFob` to `C_KEY_MAP` without adding it to `C_KEY_ALIASES` is a TypeScript error.

- [ ] **Step 1: Write the failing test**

Insert into `$SP/verify-ext-fob.mjs`, immediately before the final `console.log` summary block:

```js
// ── T2 column resolution against the REAL 30 view headers ───────────────────
const REAL_HEADERS = [
  'Customer Code','Customer Name','Base Style','Factory','Season','Style No.',
  'MSC','Color','CBD Status','Size','Team Multi','CBD Version','Revised',
  'CBD Buy Type','Last Update date','Last Update by','Final FOB',
  'Extended Size Adj%','Extended Size FOB','L4LOrderCountry','FinalFOBCur(L4L)',
  'Extended Size FOB(L4L)','Style Name','Cost Sheet No.','First Input by',
  'First Input date','Create CBD Date','Create CBD by','Comment','Refresh Data Date',
];

check('T2.1 extFob resolves to index 18', norm.findCostsheetIdx(REAL_HEADERS, 'extFob'), 18);
check('T2.2 fob still resolves to index 16', norm.findCostsheetIdx(REAL_HEADERS, 'fob'), 16);

// The near-miss columns must NOT be picked up by either key.
check('T2.3 no ext match without the column',
  norm.findCostsheetIdx(REAL_HEADERS.filter((h) => h !== 'Extended Size FOB'), 'extFob'), -1);
check('T2.4 Adj% is not an ext FOB match',
  norm.findCostsheetIdx(['Extended Size Adj%'], 'extFob'), -1);
check('T2.5 L4L variant is not an ext FOB match',
  norm.findCostsheetIdx(['Extended Size FOB(L4L)'], 'extFob'), -1);
check('T2.6 L4L variant is not a Final FOB match',
  norm.findCostsheetIdx(['FinalFOBCur(L4L)'], 'fob'), -1);

// Alias tolerance: spacing/underscore/hyphen variants of the same header.
for (const h of ['Extended Size FOB', 'EXTENDED_SIZE_FOB', 'Extended-Size-FOB', 'extendedsizefob']) {
  check(`T2.7 alias ${h}`, norm.findCostsheetIdx([h], 'extFob'), 0);
}
```

- [ ] **Step 2: Run the harness to verify it fails**

Same command as Task 1 Step 2.
Expected: FAIL on `T2.1` (`actual -1`) and on all four `T2.7` alias cases (`actual -1`). `T2.2`–`T2.6` should already PASS.

- [ ] **Step 3: Implement the column config**

In `frontend/src/lib/constants.ts`, add one line to `C_KEY_MAP` directly after the `fob:` entry (line 42):

```ts
  fob: 'Final FOB',                // MAX First Input Date wins; this is the value we compare against
  extFob: 'Extended Size FOB',     // used INSTEAD of `fob` when the Costsheet row is an extended size
```

and one line to `C_KEY_ALIASES` directly after its `fob:` entry (line 57):

```ts
  fob: ['finalfob', 'finalfobprice', 'finalfobamount'],
  extFob: ['extendedsizefob', 'extsizefob', 'extendsizefob'],
```

Note `normCColName` strips whitespace/underscores/dots/hyphens but **not** parentheses, so `Extended Size FOB(L4L)` normalises to `extendedsizefob(l4l)` and cannot collide with `extendedsizefob`.

- [ ] **Step 4: Run the harness to verify it passes**

Same command. Expected: `ALL GREEN`, 0 failed (Task 1 assertions still included and still green).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/lib/constants.ts
git commit -F - <<'EOF'
Add extFob column key for Extended Size FOB

Alias-tolerant resolution of the Costsheet view's "Extended Size FOB"
column. Cannot collide with "Extended Size FOB(L4L)" or "Extended Size
Adj%" because normCColName leaves parentheses and percent signs intact.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Pick the FOB source per row and handle the empty case

**Files:**
- Modify: `frontend/src/lib/costsheet.ts` — `CostsheetEntry` (`:19-27`), `buildCostsheetIndex` (`:55-120`), `lookupCostsheet` (`:166-173`)
- Modify: `$SP/verify-ext-fob.mjs` (append a new block before the summary)

**Interfaces:**
- Consumes: `normalizeCostsheetSizeToken` (Task 1), `C_KEY_MAP.extFob` + the `extFob` aliases (Task 2)
- Produces: no signature changes. `buildCostsheetIndex(dc)` and `lookupCostsheet(cIdx, bConvertedSize, joinKeyStr, keyNoColor)` keep their existing signatures and return shapes, so `comparison.ts` and `ResultsTable.tsx` need no edits. `CostsheetEntry` gains one internal field, `isExt: boolean`.

- [ ] **Step 1: Write the failing test**

Insert into `$SP/verify-ext-fob.mjs`, immediately before the final summary block:

```js
// ── T3 FOB source selection ─────────────────────────────────────────────────
const cs = await load('costsheet');

// Build one 30-cell row using REAL_HEADERS positions.
function mkRow({ size, finalFob, extFob, date, version = '1', csNo = 'CS-1' }) {
  const r = new Array(REAL_HEADERS.length).fill('');
  r[3] = 'HIT'; r[4] = 'FA27'; r[5] = 'STYLE-C'; r[7] = 'ALL_SOLID';
  r[9] = size; r[11] = version; r[16] = finalFob; r[18] = extFob;
  r[23] = csNo; r[25] = date;
  return r;
}
const KEY = 'fa27|style-c|all_solid|hit';
const KEY_NC = 'fa27|style-c|hit';
const look = (rows, ppsSize) =>
  cs.lookupCostsheet(cs.buildCostsheetIndex({ name: 't', headers: REAL_HEADERS, rows }), ppsSize, KEY, KEY_NC);

// T3.1 extended row uses Extended Size FOB (3.60), NOT Final FOB (3.30)
let r = look([mkRow({ size: '3XL', finalFob: '3.30', extFob: '3.60', date: '2026-01-15' })], 'ALL_EXTEND_SIZE_RB');
check('T3.1 extended uses ext FOB', [r.matched, r.fobVal, r.sizeNorm], [true, '3.60', 'ALL_EXTEND_SIZE_RB']);

// T3.2 regular row still uses Final FOB — existing behaviour must not change
r = look([mkRow({ size: 'S', finalFob: '3.00', extFob: '3.20', date: '2026-01-15' })], 'ALL_REG_SIZE_RB');
check('T3.2 regular uses Final FOB', [r.matched, r.fobVal, r.sizeNorm], [true, '3.00', 'ALL_REG_SIZE_RB']);

// T3.3 the 4X / 48 regression — now extended, so ext FOB
for (const s of ['4X', '48']) {
  r = look([mkRow({ size: s, finalFob: '9.99', extFob: '7.77', date: '2026-01-15' })], 'ALL_EXTEND_SIZE_RB');
  check(`T3.3 ${s} uses ext FOB`, [r.matched, r.fobVal], [true, '7.77']);
}

// T3.4 extended row with EMPTY ext FOB -> unmatched (blank + "No WISDOM")
r = look([mkRow({ size: '3XL', finalFob: '3.30', extFob: '', date: '2026-01-15' })], 'ALL_EXTEND_SIZE_RB');
check('T3.4 empty ext FOB -> No CS', [r.matched, r.fobVal], [false, '']);

// T3.5 newest extended row empty, older one populated -> still No CS (MAX-date rule holds)
r = look([
  mkRow({ size: '3XL', finalFob: '3.30', extFob: '',     date: '2026-06-01', version: '2' }),
  mkRow({ size: '3XL', finalFob: '2.30', extFob: '2.55', date: '2026-01-15', version: '1' }),
], 'ALL_EXTEND_SIZE_RB');
check('T3.5 newest empty wins -> No CS', [r.matched, r.fobVal], [false, '']);

// T3.6 REGULAR row with empty Final FOB keeps today's behaviour (matched, blank)
r = look([mkRow({ size: 'S', finalFob: '', extFob: '3.20', date: '2026-01-15' })], 'ALL_REG_SIZE_RB');
check('T3.6 regular empty FOB unchanged', [r.matched, r.fobVal], [true, '']);

// T3.7 bare ALL_EXTEND_SIZE (no _RB suffix) still reaches the extended branch
r = look([mkRow({ size: 'ALL_EXTEND_SIZE', finalFob: '3.30', extFob: '3.60', date: '2026-01-15' })], 'ALL_EXTEND_SIZE_RB');
check('T3.7 bare ALL_EXTEND_SIZE', [r.matched, r.fobVal, r.sizeNorm], [true, '3.60', 'ALL_EXTEND_SIZE_RB']);

// T3.8 view without the column -> warned in `missing`, extended rows unmatched
const hdrNoExt = REAL_HEADERS.filter((h) => h !== 'Extended Size FOB');
function mkRowNoExt(size, finalFob, date) {
  const r2 = new Array(hdrNoExt.length).fill('');
  r2[3] = 'HIT'; r2[4] = 'FA27'; r2[5] = 'STYLE-C'; r2[7] = 'ALL_SOLID';
  r2[9] = size; r2[16] = finalFob; r2[24] = date;
  return r2;
}
const idxNoExt = cs.buildCostsheetIndex({ name: 't', headers: hdrNoExt, rows: [mkRowNoExt('3XL', '3.30', '2026-01-15')] });
check('T3.8 missing column is warned', idxNoExt.missing.some((s) => s.includes('Extended Size FOB')), true);
const rNoExt = cs.lookupCostsheet(idxNoExt, 'ALL_EXTEND_SIZE_RB', KEY, KEY_NC);
check('T3.8 extended unmatched without column', [rNoExt.matched, rNoExt.fobVal], [false, '']);

// T3.9 MAX-date winner still wins among populated extended rows
r = look([
  mkRow({ size: '3XL', finalFob: '1.00', extFob: '5.55', date: '2026-06-01', version: '2' }),
  mkRow({ size: '3XL', finalFob: '1.00', extFob: '4.44', date: '2026-01-15', version: '1' }),
], 'ALL_EXTEND_SIZE_RB');
check('T3.9 MAX date wins', [r.matched, r.fobVal, r.dateStr], [true, '5.55', '2026-06-01']);
```

- [ ] **Step 2: Run the harness to verify it fails**

Same command as Task 1 Step 2.
Expected: FAIL on `T3.1` (`actual [true,"3.30",...]` — the current bug), `T3.3` (`"9.99"`), `T3.4`/`T3.5` (`[true,"3.30"]`), `T3.7` (`"3.30"`), and both `T3.8` assertions. `T3.2`, `T3.6`, `T3.9` should already PASS.

- [ ] **Step 3: Implement the FOB source switch**

Three edits in `frontend/src/lib/costsheet.ts`.

**(a)** Change the import on line 13 from `normalizeSizeToken` to `normalizeCostsheetSizeToken`:

```ts
import {
  findCostsheetIdx,
  normalizeJoinKey,
  normalizeCostsheetSizeToken,
  parseDate,
} from './normalize';
```

**(b)** Add `isExt` to the `CostsheetEntry` interface (after the `szRaw` field, line 22):

```ts
  szRaw: string;    // size as displayed to the user
  isExt: boolean;   // true = extended size, so fobVal came from `Extended Size FOB`
```

**(c)** In `buildCostsheetIndex`, resolve the new column next to the existing `fobIdx` (line 65):

```ts
  const fobIdx = findCostsheetIdx(hdr, 'fob');
  const extFobIdx = findCostsheetIdx(hdr, 'extFob');
```

add it to the `missing` warnings (after the `fobIdx` check, line 73):

```ts
  if (fobIdx === -1) missing.push(`FOB ("${C_KEY_MAP.fob}")`);
  if (extFobIdx === -1) missing.push(`Extended Size FOB ("${C_KEY_MAP.extFob}")`);
```

and replace the per-row size + FOB lines (lines 90 and 92):

```ts
    const szNorm = normalizeCostsheetSizeToken(szRaw);
    const dateVal = dateIdx !== -1 ? parseDate(row[dateIdx]) : null;
    // Extended-size rows price from `Extended Size FOB`; everything else from
    // `Final FOB`. Resolved here so nothing downstream needs to know which column won.
    const isExt = szNorm === 'ALL_EXTEND_SIZE_RB';
    const srcIdx = isExt ? extFobIdx : fobIdx;
    const fobVal = srcIdx !== -1 ? String(row[srcIdx] ?? '').trim() : '';
```

then add `isExt` to the entry literal (line 96):

```ts
    const entry: CostsheetEntry = { row, szNorm, szRaw, isExt, dateVal, fobVal, versionVal, costSheetNoVal };
```

**(d)** In `lookupCostsheet`, replace the winner guard on line 173:

```ts
  // An extended-size row whose `Extended Size FOB` cell is empty has no usable price:
  // report it unmatched (blank + "No WISDOM") rather than falling back to `Final FOB`
  // or to an older row — the MAX(First Input Date) winner is still the only candidate.
  // Deliberately NOT applied to regular rows: a blank `Final FOB` keeps its existing
  // behaviour so nothing that works today changes verdict.
  if (!best || (best.isExt && !best.fobVal)) return empty;
```

- [ ] **Step 4: Run the harness to verify it passes**

Same command. Expected: `ALL GREEN`, 0 failed — all Task 1, 2 and 3 assertions.

- [ ] **Step 5: Verify the TypeScript build compiles**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend"
npm run build
```

Expected: `tsc -b` reports no errors and `vite build` writes `dist/`. If `tsc` complains that `normalizeSizeToken` is now unused in `costsheet.ts`, remove it from that import — it must remain exported from `normalize.ts` for `FileSlotPPS.tsx`.

- [ ] **Step 6: Confirm the backend suite is unaffected**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
python -m pytest tests/ -v
```

Expected: 37 passed. No backend file changed, so any failure here is pre-existing — report it rather than fixing it under this plan.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/chayodom.k/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/lib/costsheet.ts
git commit -F - <<'EOF'
Use Extended Size FOB for extended-size Costsheet rows

WISDOM Final FOB previously always read the view's "Final FOB" column
regardless of size. Extended-size rows now read "Extended Size FOB"
instead; the source is resolved per row at index-build time, so
comparison.ts and ResultsTable.tsx are unchanged.

An extended row with an empty Extended Size FOB is reported unmatched
(blank, counts as No CS) rather than falling back to Final FOB or to an
older row -- the MAX(First Input Date) winner stays the only candidate.
Regular rows with an empty Final FOB keep their existing behaviour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Done when

- `$SP/verify-ext-fob.mjs` prints `ALL GREEN` with 0 failures.
- `npm run build` compiles clean.
- `python -m pytest tests/ -v` still reports 37 passed.
- Three commits on `main`, one per task.
- No new files in the repo; `REG_SIZES`, `EXTEND_SIZE`, `normalizeSizeToken`, the backend and all components untouched.

## Out of scope (spec follow-ups)

- README §6.5 does not yet say which FOB column the Costsheet side reads. Worth a short update after this ships.
- Whether `Final FOB` on an extended row holds the base or the extended price is still unverified — the MCP DB account is denied `SELECT` on `VIEW_COSTSHEET_WISDOM`. This decides whether the change fixes wrong comparisons or is a no-op for those rows; it does not block implementation.
