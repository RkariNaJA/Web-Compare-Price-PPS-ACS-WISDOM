# Design: currency-aware PPS row selection (kill the USD/THB duplicate row)

**Date:** 2026-08-05
**Project:** PPS·ACS·WISDOM Validator Dashboard (`DashBoard/`)
**Status:** Approved design (settled conversationally) — ready for implementation planning

---

## The bug

After Validate, one logical quote can appear as **two rows** with wildly different "PPS FOB"
values. Reported case — `STYLE-A` / `SU27` / `HIT` / size `4XL`:

| Rows in `dbo.PPS` | `LOCAL_CURRENCY` | `LOCAL_QUOTE_AMOUNT` |
| ----------------- | ---------------- | -------------------- |
| 4 | USD | 4.00 |
| 2 | THB | 124.00 |

`124.00 ÷ 4.00 = 31.2` — the THB/USD rate. **They are the same price quoted twice.** The
source data is not duplicated; the output table is.

## Root cause

Three steps, each behaving exactly as written:

1. **`sql_backend.py:395`** — `SELECT * FROM dbo.PPS WHERE FTYCODE = ?`. Every row, no dedupe,
   **no `ORDER BY`**. `LOCAL_CURRENCY` *does* reach the browser.
2. **`FileSlotPPS.tsx:30-55`** (`toPPSRows`) projects the payload down to `STRICT_B_COLS`
   (`constants.ts:67-76`). That list contains `LOCAL_QUOTE_AMOUNT` but **not `LOCAL_CURRENCY`**.
   The currency is destroyed here, and nothing downstream can recover it.
3. **`dedupePPSRows` (`comparison.ts:109-136`)** keys on
   `SEASON_YEAR | STYLE | COLOR | ORIG_SIZE_DATA | LOCAL_QUOTE_AMOUNT`. Because
   `4.00 ≠ 124.00` these are two distinct keys, so both survive — which is deliberate
   (`comparison.ts:99-101`: rows with a different quote can have a different verdict).

So the dedup is correct and the backend is correct. **Step 2 is the defect**: it throws away the
one column that would let the app tell a currency twin from a genuinely different quote.

Consequence beyond the duplicate: the THB row is compared against ACS's USD FOB, so it is a
**guaranteed false Diff** and it inflates the Diff count in the Summary tab.

## Scale (measured against the live table)

Grouped by `FTYCODE · SEASON_YEAR · STYLE · COLOR · SIZE_DATA`:

| Case | Groups |
| ---- | ------ |
| Both USD and THB — **the duplicate** | **~4.8k** |
| USD only | ~22k |
| THB only (no USD twin) | **5** |
| 2+ *distinct* USD amounts (revised quotes) | 174 |

Raw rows: ~109k USD · ~6.8k THB. Only these two currencies exist in the table.

The 5 THB-only groups are 2 real styles: `STYLE-D` (`SP27`/`HIT`, sizes `S-T`/`M-T`/`L-T`, 500.00)
and `STYLE-E` (`SP27`/`HIT`, blank size 600.00 and `3XL` 650.00). A blanket
`WHERE LOCAL_CURRENCY = 'USD'` would erase these from validation with no trace — which is why
this design prefers rather than filters.

## Scope decisions (agreed)

- **Prefer USD per group, fall back rather than drop.** Grouping on
  `SEASON_YEAR | STYLE | COLOR | ORIG_SIZE_DATA` — deliberately **without** the amount, since
  that is what differs between currency twins.
- **THB-only groups stay visible and are marked not-comparable.** They render with their
  currency shown and their FOB comparison **skipped**, rather than forced against a USD value and
  reported as a false Diff. Nothing disappears silently and the Diff count stays honest.
- **Revised quotes keep today's behaviour.** The amount stays in the `dedupePPSRows` key, so the
  174 multi-amount groups keep showing one row per distinct amount, each with its own verdict.
- **`INSERT_DATE` is added to `STRICT_B_COLS` so the newest-wins tie-break actually runs.**
  `dedupePPSRows:116` reads `h.indexOf('INSERT_DATE')` and `:128` guards on `insertIdx !== -1`,
  which is **always false today** because step 2 already deleted the column. Honest caveat: since
  the amount stays in the key, this only breaks ties between rows with an *identical* amount, and
  measurement shows **0** dedup keys anywhere in the table have conflicting `MSC_CODE` or
  `RESPONSIBLE_DEVELOPER`. **It changes no output today.** It is added because the code already
  intends it and the comment at `:118-119` already claims it — that comment is currently false and
  would mislead the next reader.
- **Currency preference lives in `comparison.ts`, next to `dedupePPSRows`** — not in
  `FileSlotPPS`. All row-selection logic then sits in one place, and the PPS preview keeps showing
  what the database actually returned.
- **`'USD'` becomes a named constant**, not a literal buried in a function, so future THB support
  is one line plus a UI control.

## Non-goals (YAGNI)

- No currency **conversion**. No exchange-rate table, no THB→USD arithmetic.
- No currency selector in the UI yet. The preferred currency is a constant this change makes
  easy to promote later.
- No change to `dbo.PPS`, to `sql_backend.py`, or to the ACS / Costsheet sides.
- No change to the dedup key (the amount stays in it).
- No backfill or cleanup of annotations orphaned by rows that stop being emitted (see Edge cases).

---

## Implementation

### 1. `frontend/src/lib/constants.ts`

```ts
// Currency the validator compares in. PPS quotes in any other currency are kept but not
// compared (ACS / Costsheet FOBs are all in this currency). Promote to a user-facing
// setting when real multi-currency support arrives.
export const PREFERRED_CURRENCY = 'USD';

export const STRICT_B_COLS = [
  'MSC_CODE',
  'RESPONSIBLE_DEVELOPER',
  'SEASON_YEAR',
  'STYLE',
  'COLOR',
  'FTYCODE',
  'SIZE_DATA',
  'LOCAL_QUOTE_AMOUNT',
  'LOCAL_CURRENCY',   // needed to tell a currency twin from a genuinely different quote
  'INSERT_DATE',      // makes dedupePPSRows' newest-wins tie-break actually run
];
```

### 2. `frontend/src/lib/comparison.ts`

**New `preferUSDRows(fileB)`, run immediately before `dedupePPSRows`.** Groups on the dedup key
*minus* the amount; if a group holds any `PREFERRED_CURRENCY` row, the other currencies are
dropped from that group; otherwise the group is kept intact.

```ts
// dbo.PPS quotes the same price once per currency (USD and THB today), so a single
// logical quote arrives as two rows with different LOCAL_QUOTE_AMOUNTs — 4.00 USD and
// 124.00 THB are the same price. Collapse to the preferred currency per
// (season, style, color, size) group; groups with NO preferred-currency row are left
// alone so a THB-only quote still reaches the table (marked not-comparable downstream).
// Returns the rows unchanged when LOCAL_CURRENCY is absent (a non-DB source).
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

**`CompRow` gains two fields** (`types.ts`):

```ts
  currency: string;     // LOCAL_CURRENCY of the PPS row ('' when the source has no such column)
  comparable: boolean;  // false = quoted in a non-preferred currency, so FOB comparison is skipped
```

`currency` stores the **raw** cell value (so the table shows exactly what the DB holds), while
`comparable` is derived with the same normalisation `preferUSDRows` uses — otherwise a padded
`'usd '` would be kept by the filter but then marked not-comparable:

```ts
const currency = curIdx !== -1 ? String(rowB[curIdx] ?? '').trim() : '';
const comparable = currency === '' || currency.toUpperCase() === PREFERRED_CURRENCY;
```

When `comparable` is `false`: `valueMatch` is `false`, `lqVsAcs` is `false`, and `cMatch` stays
`null` — the FOB comparisons are **not performed at all** rather than performed and failed.

**Extract the verdict derivation.** Four places currently re-derive the verdict from
`status` + `valueMatch`: `comparison.ts:493-495`, `summary.ts:33-34`, `csv.ts:20-23`, and the
table/toolbar. A fourth state cannot be added consistently while that logic is copied four times,
so export one helper from `comparison.ts` and have the others use it:

```ts
export type Verdict = 'match' | 'diff' | 'noKey' | 'notCompared';

export function verdictOf(r: CompRow): Verdict {
  if (r.status === 'noKeyMatch') return 'noKey';
  if (!r.comparable) return 'notCompared';
  return r.valueMatch ? 'match' : 'diff';
}
```

`noKey` is checked first: a row with no ACS match is still a No Key Match regardless of currency.

No import cycle results: `comparison.ts` imports `types` / `constants` / `normalize` / `costsheet`
and neither `summary.ts` nor `csv.ts`, so both can safely import from it.

`CompareResult` gains `notComparedCount`, and `diffCount` is computed via `verdictOf` so
not-compared rows are **excluded** from it.

**Report currency filtering separately from dedup.** `collapsedRows` (`comparison.ts:498`) is
`rawPPSRows - compRows.length` and is presented to the user as de-duplication. Currency-filtered
rows would silently inflate it. Add a separate `currencyFilteredRows` count so the toast can say
*"~4.8k non-USD rows excluded"* rather than disguising the filtering as dedup.

### 3. `frontend/src/lib/summary.ts` and `frontend/src/lib/csv.ts`

- `summary.ts`: delete the local `verdictOf` (`:33-34`), import the shared one, add `notCompared`
  to `VerdictCounts` and `blank()`.
- `csv.ts`: delete the local `verdict` (`:20-23`), map the shared verdict to the existing
  uppercase strings plus `NOT_COMPARED`. Add a `LOCAL_CURRENCY` column to the export, and return
  `''` from `diffReason` for not-compared rows.

### 4. `frontend/src/components/ResultsTable.tsx` and `ResultsToolbar.tsx`

- A `Currency` column beside `LOCAL_QUOTE_AMOUNT`.
- A distinct badge for `notCompared` (not the red Diff badge) reading e.g. `— THB`, with a
  tooltip explaining the row is quoted in a non-compared currency.
- The toolbar's `filterMode` (`'all' | 'match' | 'diff' | 'nokey'`) gains `'notcompared'`, with a
  count chip alongside the existing three.

### Resulting behaviour

| Case | Groups | Before | After |
| ---- | ------ | ------ | ----- |
| USD + THB twins | ~4.8k | 2 rows; THB row a false Diff | **1 row** (USD) |
| USD only | ~22k | unchanged | unchanged |
| THB only | 5 | 1 row, false Diff | 1 row, **not compared** |
| 2+ distinct USD amounts | 174 | one row per amount | unchanged |

## Edge cases and their decided behaviour

- **Non-DB PPS source with no `LOCAL_CURRENCY` column** (an uploaded spreadsheet). `preferUSDRows`
  returns the rows untouched, `currency` is `''`, and `comparable` is `true` — identical to
  today's behaviour. Mirrors the existing defensive guard at `dedupePPSRows:115`.
- **Currency casing / whitespace.** Compared after `trim().toUpperCase()`, so `usd` and `USD `
  both count as preferred.
- **A group holding USD, THB *and* a third currency.** The third is dropped along with THB — the
  rule is "keep the preferred currency if present", not "keep two".
- **Orphaned annotations.** `rowKey` includes `LOCAL_QUOTE_AMOUNT`, so any Error From / Done value
  a user saved against a THB row will no longer match a displayed row. Those SQLite rows are
  inert (they simply never join) and are deliberately left in place — deleting user-entered data
  to tidy up would be worse than leaving it. Worth telling users the THB rows they may have
  triaged will disappear.
- **`INSERT_DATE` string comparison.** `dedupePPSRows:130` compares stringified dates
  lexicographically, which is correct for `datetime2` (year-first). Now that the column actually
  survives, that assumption becomes live — it holds for the current backend, which stringifies
  every cell in `sql_backend.py`.

## Verification

Same approach as the extended-size FOB change: `lib/` is pure but the frontend has **no test
framework**, and one is deliberately not being added. Verification runs through a Node harness in
the session scratchpad that esbuild-bundles the real `lib/` modules (Node cannot import them
directly — their internal imports are extensionless and only Vite resolves those).

Cases to cover:

1. USD+THB twin group → one row, USD, `comparable: true`.
2. THB-only group → one row, `currency: 'THB'`, `comparable: false`, `verdictOf` → `notCompared`.
3. USD-only group → unchanged.
4. Group with 2 distinct USD amounts → still two rows (the 174-group case must not regress).
5. Group with 2 distinct USD amounts **and** THB rows → two USD rows, THB dropped.
6. Headers without `LOCAL_CURRENCY` → rows untouched, all `comparable: true`.
7. Lowercase / padded `usd` → treated as preferred.
8. `notCompared` excluded from `diffCount`; `summarize()` and the CSV verdict agree with
   `verdictOf` for all four states.
9. `currencyFilteredRows` counts exactly the rows `preferUSDRows` removed.
10. A `noKeyMatch` row in a non-preferred currency resolves to `noKey`, not `notCompared`.

Plus `npm run build` (`tsc -b && vite build`) and the backend `pytest` suite (expected unaffected —
no backend file changes).

## Suggested task split

Ordered so the duplicate dies first and independently:

1. **Row selection** — `constants.ts` + `preferUSDRows` in `comparison.ts` + `currency` /
   `comparable` on `CompRow`. Kills the duplicate. Shippable alone.
2. **Verdict plumbing** — shared `verdictOf`, `notCompared` state through `comparison.ts`,
   `summary.ts`, `csv.ts`, the new counts.
3. **UI surface** — currency column, not-compared badge, toolbar filter, toast wording.

## Follow-ups (not in this change)

- README's PPS de-duplication section documents the dedup key but not currency handling; it needs
  the new rule and the `PREFERRED_CURRENCY` constant once this ships.
- Real THB support (conversion or per-currency validation) is the eventual goal;
  `PREFERRED_CURRENCY` is the seam for it.
- `sql_backend.py:395` has no `ORDER BY`, so PPS row order is not guaranteed stable across loads.
  Harmless today (measured: no dedup key has conflicting display fields) but it makes
  first-seen-wins non-deterministic in principle.
