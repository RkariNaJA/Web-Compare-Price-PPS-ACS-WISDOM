# Validation Summary Tab — Implementation Plan

> Executed **inline** (frontend-only, low-risk). Verify each task with `npm run build` from `DashBoard/frontend`. No backend, no git.

**Goal:** A public "Summary" view showing Match/Diff/No Key by Factory and by Season (stacked bars) + a Factory×Season breakdown table, from the current validation's `compRows`.

**Architecture:** Pure aggregation in `lib/summary.ts`; presentational `SummaryDashboard.tsx`; wired into the existing `view` switcher (all logged-in users). Hand-rolled bars using `--match`/`--mismatch`/`--only`. See `docs/superpowers/specs/2026-07-22-validation-summary-design.md`.

## Global Constraints
- Frontend only; no new dependency; token-driven (light+dark).
- Match/Diff/No Key colors = `--match` / `--mismatch` / `--only`, fixed order everywhere.
- Identity never color-alone: legend always present + breakdown table gives exact numbers.
- `npm run build` must stay green after each task.

---

## Task 1 — types + pure aggregation
**Files:** `frontend/src/lib/types.ts` (extend `AppView`), `frontend/src/lib/summary.ts` (new).
- `AppView` → `'menu' | 'log' | 'compare' | 'summary'`.
- `summary.ts` exports `VerdictCounts`, `GroupCount`, `FactorySeasonRow`, `Summary`, and `summarize(rows: CompRow[]): Summary` — one pass: classify each row (`noKeyMatch`→noKey, else `valueMatch`?match:diff), bucket by factory / season / (factory,season), plus totals. `byFactory`/`bySeason` sorted by total desc; `byFactorySeason` sorted by factory then season.
- Verify: `npm run build`.

## Task 2 — CSS + SummaryDashboard component
**Files:** `frontend/src/styles/global.css` (append `.summary-*`), `frontend/src/components/SummaryDashboard.tsx` (new).
- Component props `{ rows: CompRow[] }`; `useMemo(summarize)`. Empty state when `rows.length===0`.
- Layout: KPI strip (Match/Diff/No Key/Match-rate) → legend → "By Factory" stacked-bar card → "By Season" stacked-bar card → "Factory × Season" breakdown table (reuses `.log-table`).
- Bars: horizontal, width = `total/max`, segments `flex-grow`=count, 2px gaps, rounded ends, per-segment `title` tooltip.
- Verify: `npm run build` (compiles unused).

## Task 3 — wiring (Header switcher + App branch)
**Files:** `frontend/src/components/Header.tsx`, `frontend/src/App.tsx`.
- Header: switcher shows for **every** logged-in user (`Compare Data | Summary`); `Log` only when `can_manage`. Keep `.active` highlight.
- App: import `SummaryDashboard`; add `if (view === 'summary') return (<div className="app">{header}<SummaryDashboard rows={compRows} /></div>);`.
- Verify: `npm run build` + manual (validate ≥2 factories/seasons → Summary totals match toolbar; empty state before validate; non-admin sees Summary, not Log).
