# Design: Costsheet extended-size FOB (use `Extended Size FOB` for extended sizes)

**Date:** 2026-08-05
**Project:** PPS·ACS·WISDOM Validator Dashboard (`DashBoard/`)
**Status:** Approved design (settled conversationally) — ready for implementation planning

---

## Goal

Today the **WISDOM Final FOB** column always reads the Costsheet view's `Final FOB` column,
whatever the row's size. Change it so that when a Costsheet row's size is an **extended** size,
the value comes from the view's **`Extended Size FOB`** column instead.

Regular-size rows are unaffected and keep using `Final FOB`.

## Findings that shaped this design

Two things were verified against the code and the live view before designing:

1. **The size transform already exists.** The 31 sizes named in the request
   (`4X, 1X-T, 2X-T, 3X-T, 3XL, 4XL, 5XL, S-T, M-T, L-T, L-TT, XL-T, 2XL-T, 3XL-T, 4XL-T, 5XL-T,
   MTT, LTT, XLTT, XL-TT, 2XLTT, 3XLTT, CUST1, CUST3, 48, 58, 60, 48R, 48+1, 48+2, 48-1`) are
   **character-for-character identical** to the existing `EXTEND_SIZE` constant in
   `constants.ts:95` — same 31 entries, same order. No list needs to be added or edited.

   Costsheet rows already run through that transform at `costsheet.ts:90`
   (`normalizeSizeToken`), so **29 of the 31 already normalise to `ALL_EXTEND_SIZE_RB` today**.

2. **`4X` and `48` are the exception — they appear in _both_ `REG_SIZES` and `EXTEND_SIZE`.**
   `normalizeSizeToken` checks `REG_SIZES` first and returns early, so those two resolve to
   `ALL_REG_SIZE_RB` and never reach the extended branch.

Therefore the genuinely missing piece is **only the FOB column switch**, plus a decision about
`4X` / `48`.

### Verified against the live view

`dbo.VIEW_COSTSHEET_WISDOM` has four FOB-ish columns. Header matching (`normCColName`) strips
whitespace/underscores/dots/hyphens and lowercases, but **not** parentheses:

| View column | Normalises to | Used today | Used after this change |
| ----------- | ------------- | ---------- | ---------------------- |
| `Final FOB` | `finalfob` | ✅ | ✅ regular sizes |
| `Extended Size FOB` | `extendedsizefob` | ❌ | ✅ **extended sizes** |
| `FinalFOBCur(L4L)` | `finalfobcur(l4l)` | ❌ | ❌ |
| `Extended Size FOB(L4L)` | `extendedsizefob(l4l)` | ❌ | ❌ |

`Extended Size Adj%` (→ `extendedsizeadj%`) also stays unused. None of the near-misses collide
with the new `extendedsizefob` alias.

**Not verified:** the MCP database account returns *Permission denied* on every `SELECT` against
`VIEW_COSTSHEET_WISDOM` (it can read `dbo.ACS` and `INFORMATION_SCHEMA` only). So how often
`Extended Size FOB` is populated, and how it relates to `Final FOB` on extended rows, is
**unknown**. This is why the NULL case below has an explicitly defined behaviour.

## Scope decisions (agreed)

- **Costsheet-only.** The `4X` / `48` reclassification applies to Costsheet rows only. PPS and
  ACS continue to treat them as regular sizes. `REG_SIZES` and `EXTEND_SIZE` are **not edited** —
  `normalizeSizeToken` is shared with `FileSlotPPS.tsx:51`, which rewrites every uploaded PPS
  row's `SIZE_DATA`, so editing the lists would move PPS bucketing and ACS row matching too and
  could flip verdicts that pass today.
- **The Costsheet row's own size decides the FOB source** — not the PPS row's size. This mirrors
  the request's wording ("if in costsheet db size = …").
- **Missing `Extended Size FOB` ⇒ no usable Costsheet price.** The row renders `—` and is
  excluded from the 3-way verdict, exactly like any unmatched row.
- **That rule applies to extended-size rows ONLY.** A regular-size row with an empty
  `Final FOB` keeps today's behaviour (renders `—`, counts as a Diff). This keeps the change
  strictly additive: no row that works today can change verdict.
- **No UI changes.** `cMatched` already drives the blank rendering and the `No WISDOM` diff
  reason (`ResultsTable.tsx:241, 275, 366, 407, 421`), so returning `matched: false` produces the
  agreed behaviour with no component edits.
- **No backend changes.** `sql_backend.py` issues `SELECT *`, so `Extended Size FOB` is already
  present in the headers the frontend receives.

## Non-goals (YAGNI)

- No `cFobSource` pill showing which Costsheet column was used (ACS has one for
  `FinalFOB`/`ExtSzFOB`). Can be added later if it proves useful for debugging.
- No use of the `(L4L)` currency variants or `Extended Size Adj%`.
- No change to the MAX(First Input Date) winner rule.
- No change to the ACS side's `FinalFOB`/`ExtSzFOB` logic.
- No new test framework in the repo (see Verification).

---

## Implementation

Three files change.

### 1. `frontend/src/lib/constants.ts`

Add a second logical FOB key:

```ts
export const C_KEY_MAP = {
  // …
  fob: 'Final FOB',
  extFob: 'Extended Size FOB',   // used instead of `fob` when the Costsheet row is an extended size
  // …
} as const;

export const C_KEY_ALIASES: Record<keyof typeof C_KEY_MAP, string[]> = {
  // …
  extFob: ['extendedsizefob', 'extsizefob', 'extendsizefob'],
};
```

### 2. `frontend/src/lib/normalize.ts`

Add a Costsheet-only resolver that checks EXTEND **first**:

```ts
// Costsheet-only size normalisation. Identical to normalizeSizeToken EXCEPT that
// EXTEND_SIZE is checked FIRST. '4X' and '48' are the only two values present in
// both lists, so they resolve to ALL_EXTEND_SIZE_RB here while PPS/ACS keep
// treating them as regular sizes via normalizeSizeToken.
export function normalizeCostsheetSizeToken(raw: unknown): string {
  let s = convertBExtendSize(String(raw).trim());
  if (s !== 'ALL_EXTEND_SIZE_RB') s = convertBSize(s);
  return s || 'ALL_REG_SIZE_RB';
}
```

`normalizeSizeToken` is left untouched.

### 3. `frontend/src/lib/costsheet.ts`

**`buildCostsheetIndex`** — resolve the new column, normalise with the new resolver, and pick the
FOB source per row at index-build time:

```ts
const extFobIdx = findCostsheetIdx(hdr, 'extFob');
if (extFobIdx === -1) missing.push(`Extended Size FOB ("${C_KEY_MAP.extFob}")`);

// per row:
const szNorm = normalizeCostsheetSizeToken(szRaw);
const isExt  = szNorm === 'ALL_EXTEND_SIZE_RB';
const fobVal = isExt
  ? (extFobIdx !== -1 ? String(row[extFobIdx] ?? '').trim() : '')
  : (fobIdx    !== -1 ? String(row[fobIdx]    ?? '').trim() : '');
```

`CostsheetEntry` keeps its single `fobVal` field — the source is already resolved by the time it
is stored, so nothing downstream needs to know which column it came from. It gains one internal
field, `isExt: boolean`, so the lookup can tell which rows the empty-FOB rule applies to.

**`lookupCostsheet`** — after the MAX-date winner is chosen, treat an empty `fobVal` on an
**extended** row as no usable price:

```ts
if (!best || (best.isExt && !best.fobVal)) return empty;   // was: if (!best) return empty;
```

The `isExt` guard is deliberate: without it, regular rows with a blank `Final FOB` would flip
from Diff to No CS, which is a change to existing results that was not requested.

### Resulting behaviour

| Costsheet row size | Normalises to | FOB source | WISDOM Final FOB shows |
| ------------------ | ------------- | ---------- | ---------------------- |
| `S`, `M`, `40`, `46R` … | `ALL_REG_SIZE_RB` | `Final FOB` | the price *(unchanged)* |
| `3XL`, `XL-T`, `CUST1`, `58` … (29 sizes) | `ALL_EXTEND_SIZE_RB` | **`Extended Size FOB`** | the extended price |
| `4X`, `48` | **`ALL_EXTEND_SIZE_RB`** *(changed)* | **`Extended Size FOB`** | the extended price |
| extended size, `Extended Size FOB` is NULL | `ALL_EXTEND_SIZE_RB` | none | `—`, counts as No CS |

## Edge cases and their decided behaviour

- **Newest extended row has a NULL `Extended Size FOB`, an older one has a value.**
  Report No CS. The MAX(First Input Date) rule is not relaxed — quietly falling back to an older
  row would display a stale price as if it were current. Accepted cost: a usable older price is
  hidden.
- **Last-resort size fallback** (`costsheet.ts:162`, `if (!sized.length) sized = candidates`)
  is unchanged. A regular-size PPS row that finds *only* extended Costsheet rows will now compare
  against `Extended Size FOB`. This follows directly from "the Costsheet row's own size decides".
- **The view lacks an `Extended Size FOB` column entirely.** `findCostsheetIdx` returns -1, the
  name is pushed onto `missing`, and the existing toolbar warning
  ("Costsheet missing columns: …") fires. Every extended row then shows `—` / No CS rather than
  silently falling back to `Final FOB` — consistent with the NULL decision above.
- **Bare `ALL_EXTEND_SIZE`** (no `_RB` suffix) is still repaired at `costsheet.ts:89` before
  normalisation, so it continues to reach the extended branch.
- **Regular-size row with an empty `Final FOB`.** Unchanged — still `matched: true` with a blank
  value, which renders `—` and reads as a Diff. Only extended rows are subject to the new rule.

## Verification

`lib/` is pure with no React, but the frontend has **no test framework** — `package.json` has no
`test` script and no vitest. Rather than adding one, verification runs as a throwaway Node script
in the session scratchpad (no new files in the repo) that imports the real constants and exercises
`normalizeCostsheetSizeToken` plus `buildCostsheetIndex`/`lookupCostsheet` against synthetic rows
using the **real** view headers.

Cases to cover:

1. All 31 extended sizes → `ALL_EXTEND_SIZE_RB` and source `Extended Size FOB`.
2. `4X` and `48` specifically → extended (the regression this change is for).
3. Representative regular sizes (`S`, `M`, `40`, `46R`) → `ALL_REG_SIZE_RB` and source
   `Final FOB` — proving no change to existing behaviour.
4. Extended row with NULL `Extended Size FOB` → `matched: false`.
5. Newest extended row NULL + older one populated → still `matched: false`.
6. Header variant `ALL_EXTEND_SIZE` (no `_RB`) → extended.
7. `normalizeSizeToken` still returns `ALL_REG_SIZE_RB` for `4X` / `48` — proving PPS and ACS
   are untouched.
8. Regular row with an empty `Final FOB` → still `matched: true` with a blank value, proving the
   new rule did not leak into regular rows.
9. The view lacking an `Extended Size FOB` column → warned in `missing`, extended rows unmatched.

Plus `npm run build` (`tsc -b && vite build`) to confirm the TypeScript compiles, and the backend
pytest suite is expected to be unaffected (no backend files change).

## Follow-ups (not in this change)

- Confirm with someone holding read access whether `Final FOB` on an extended-size row holds the
  base or the extended price. If it holds the extended price already, this change is a no-op for
  those rows; if it holds the base price, this change fixes silently wrong comparisons.
- README §6.5 documents the MAX-date rule but not which FOB column is read. Worth a short update
  once this ships.
