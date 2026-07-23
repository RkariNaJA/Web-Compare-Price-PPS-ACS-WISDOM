# Design: Validation Summary tab (Match / Diff / No Key by Factory & Season)

**Date:** 2026-07-22
**Project:** PPS·ACS·WISDOM Validator Dashboard (`DashBoard/`)
**Status:** Approved design (settled conversationally) — ready for implementation planning

---

## Goal

Add a third view, **Summary**, that turns the current validation's row-by-row results into an
at-a-glance quality picture: **Match / Diff / No Key** counts broken down **by Factory** and **by
Season**, as stacked bars, plus a per-Factory×Season **breakdown table** with the exact numbers.
Available to **all logged-in users** via the header switcher.

## Scope decisions (agreed)

- **This-validation scope, client-side only.** The Summary aggregates the current in-memory
  `compRows` (the output of the last Validate). No backend, no SQL, no new endpoint. It reflects
  only the factories/seasons the user loaded for that run.
- **Public to all logged-in users** (unlike the admin-only Log). No sensitive data — it's just a
  count of rows the user can already see in the Compare table.
- **Reached via the header switcher** — no new landing-chooser card. Non-admins land on Compare
  and flip to Summary; admins also still have Log.
- **Empty until Validate** — if there are no `compRows`, show a "Run a validation first" state.
- **Hand-rolled charts** — no new charting dependency; SVG/CSS bars using the app's existing
  status tokens. Washi/sumi styling, light + dark via tokens.

## Non-goals (YAGNI)

- No company-wide / all-factory aggregate (that would need loading every factory or a backend
  roll-up) — explicitly this-validation only.
- No new chart library, no backend changes, no persistence of summaries.
- No CSV export of the summary (the Compare CSV already carries per-row verdicts) — can add later.
- No drill-down/click-to-filter yet (nice future add: click a factory bar → filter Compare).

---

## The three verdict categories (same as the toolbar)

For each `CompRow`:
- **Match** = `row.valueMatch === true`
- **Diff** = `row.status === 'matched' && !row.valueMatch`
- **No Key** = `row.status === 'noKeyMatch'`

Factory and Season come from the key columns (same source the toolbar dropdowns use):
- **Season** = `row.keys.find(k => k.aName === 'Season')?.bVal || '—'`
- **Factory** = `row.keys.find(k => k.aName === 'FactoryCode')?.bVal || '—'`

Colors (existing tokens, reused everywhere for consistency): **Match → `--match`** (green),
**Diff → `--mismatch`** (red), **No Key → `--only`** (amber).

---

## Component 1 — `lib/summary.ts` (new, pure)

Pure aggregation, no React (matches the app's `lib/` pattern of testable logic):

```ts
export interface VerdictCounts { match: number; diff: number; noKey: number; total: number; }
export interface GroupCount extends VerdictCounts { key: string; }        // key = factory or season
export interface FactorySeasonRow extends VerdictCounts { factory: string; season: string; }
export interface Summary {
  totals: VerdictCounts;
  byFactory: GroupCount[];               // sorted by total desc
  bySeason: GroupCount[];                // sorted by total desc
  byFactorySeason: FactorySeasonRow[];   // sorted by factory, then season
}
export function summarize(rows: CompRow[]): Summary;
```

One pass over `rows`: classify each into match/diff/noKey, and increment the totals + the
factory bucket + the season bucket + the (factory,season) bucket. Empty input → all-zero
`totals` and empty arrays.

## Component 2 — `components/SummaryDashboard.tsx` (new)

Props: `{ rows: CompRow[] }` (the unfiltered `compRows`). Layout, top to bottom:

1. **KPI strip** — four stat tiles: **Match**, **Diff**, **No Key** (each with its color dot +
   big mono number) and **Match rate %** (match/total). Headline numbers.
2. **Legend** — one row: ● Match · ● Diff · ● No Key (color chips + text). Present once, shared by
   both charts (identity is never color-alone).
3. **Chart: By Factory** — one **horizontal stacked bar per factory**. Bar length scaled to
   `rowTotal / maxTotal` (so volume is comparable); segments Match|Diff|No Key with a **2px surface
   gap** between them and 4px-rounded outer ends. Factory label at left, total at right. Each
   segment has a `title` tooltip (`factory · verdict · n (x%)`).
4. **Chart: By Season** — same, one bar per season.
5. **Breakdown table** — one row per **Factory × Season**, grouped by factory, columns:
   `Factory · Season · Match · Diff · No Key · Total`, verdict numbers color-coded + monospace, a
   **Totals** row at the bottom. Scrolls vertically inside its card if long; never overflows the page.

If `rows.length === 0` → a centered empty state ("No validation yet — run a validation in
**Compare Data**, then come back here.").

Charts are hand-rolled (flex/CSS or inline SVG); recessive axes/gridlines; the card chrome matches
`.log-card` / `.group-card`.

## Component 3 — wiring (`App.tsx`, `Header.tsx`, `lib/types.ts`)

- **`lib/types.ts`** — extend `AppView` to `'menu' | 'log' | 'compare' | 'summary'`.
- **`App.tsx`** — add a `view === 'summary'` branch that renders `<SummaryDashboard rows={compRows} />`
  under the shared `header`. `compRows` already lives in `AppInner`, so switching tabs preserves the
  validation. Non-admin default stays `'compare'`.
- **`Header.tsx`** — the switcher currently shows only for `can_manage`. Restructure so **every
  logged-in user** sees `Compare Data | Summary`, and **`Log` shows only when `can_manage`**:
  ```
  {onSetView && (
    <span class="view-switch">
      <button …compare… /> <button …summary… />
      {user.perms?.can_manage && <button …log… />}
    </span>
  )}
  ```
  The active view keeps the `.btn-ghost.active` highlight.

## Styling (`global.css`)

New `.summary-*` classes: KPI strip (reuse the stat-tile look), legend chips, the stacked-bar rows
(label · track · total), segment fills (`--match`/`--mismatch`/`--only`, 2px gaps, rounded ends),
and the breakdown table (reuse `.log-table` conventions: uppercase micro-headers, mono numbers,
hairline rows). All token-driven so light + dark both work.

## Accessibility / dataviz checks

- **Legend always present** + the breakdown table gives exact numbers → identity never relies on
  color alone (important since Match=green / Diff=red is a red-green pair).
- Verdict order is fixed (Match, Diff, No Key) everywhere.
- Per-segment hover `title` tooltips; the table is the built-in "table view."
- Reuses the app's already-validated status palette; dark mode via the same tokens.

## Testing

- No frontend test runner → verify via `npm run build` (typecheck) + manual: validate a run with
  ≥2 factories/seasons, open Summary, confirm the KPI totals equal the toolbar counts, bars +
  breakdown add up, empty state shows before validating, and a non-admin (no `can_manage`) can see
  Summary but not Log.
- `lib/summary.ts` is pure — if a test runner is ever added, it's trivially unit-testable.

## Rollout

Frontend-only; no `.env`, no backend, no migration. Ships behind the existing view system.
