/**
 * Toolbar above the results table.
 *
 * Two fixed rows so nothing jumps around when the window is resized:
 *   Row 1 — stat pills (Match / Diff / No Key / Not Compared / Showing) on the
 *           left; Unsaved marker, Save and Export CSV on the right.
 *           "Not Compared" only renders when non-zero.
 *   Row 2 — every filter: verdict toggle buttons, Season / Factory / Team Mer
 *           dropdowns, MSC Code & Developer combo fields (type-to-filter or pick
 *           from the datalist), the search box, and Clear Filters (full reset).
 *
 * All filter state lives in App.tsx — this component is purely presentational
 * (dropdown options are derived from the current rows).
 *
 * Filter buttons are MULTI-SELECT toggles:
 *   • "All" clears every category (empty set = show everything).
 *   • "Match" / "Diff" / "No Key" / "Not Compared" each toggle independently.
 *     Rows matching ANY active category are shown (OR semantics), so you can
 *     view Match+Diff together while hiding No Key rows.
 */
import type { CompRow } from '../lib/types';
import { merTeamOptions } from '../lib/merTeam';

// A single filter category. App owns a Set<FilterCategory>; empty set = show all.
export type FilterCategory = 'match' | 'diff' | 'nokey' | 'notcompared';

interface Props {
  rows: CompRow[];              // *unfiltered* rows (for computing dropdown options)
  filteredCount: number;        // after all filters have been applied
  matchCount: number;
  diffCount: number;
  noKeyCount: number;
  notComparedCount: number;
  activeFilters: Set<FilterCategory>;
  toggleFilter: (c: FilterCategory) => void;
  clearFilters: () => void;
  search: string;
  setSearch: (s: string) => void;
  seasonFilter: string;
  setSeasonFilter: (s: string) => void;
  factoryFilter: string;
  setFactoryFilter: (s: string) => void;
  merTeamFilter: string;
  setMerTeamFilter: (s: string) => void;
  developerFilter: string;
  setDeveloperFilter: (s: string) => void;
  mscCodeFilter: string;
  setMscCodeFilter: (s: string) => void;
  clearAllFilters: () => void;  // resets categories + dropdowns + combo fields + search
  onExport: () => void;         // fires exportComparisonCSV
  onSave: () => void;           // POST the annotations to the backend (shared save)
  saving: boolean;              // a save is in flight
  dirty: boolean;               // unsaved local edits exist
  canEdit: boolean;             // false → Save disabled (server also rejects)
}

export default function ResultsToolbar({
  rows,
  filteredCount,
  matchCount,
  diffCount,
  noKeyCount,
  notComparedCount,
  activeFilters,
  toggleFilter,
  clearFilters,
  search,
  setSearch,
  seasonFilter,
  setSeasonFilter,
  factoryFilter,
  setFactoryFilter,
  merTeamFilter,
  setMerTeamFilter,
  developerFilter,
  setDeveloperFilter,
  mscCodeFilter,
  setMscCodeFilter,
  clearAllFilters,
  onExport,
  onSave,
  saving,
  dirty,
  canEdit,
}: Props) {
  // Derive dropdown options from the actual data — only show seasons/factories
  // that appear in the current comparison. new Set dedupes; sort alphabetises.
  const seasons = [
    ...new Set(rows.map((r) => r.keys.find((k) => k.aName === 'Season')?.bVal || '').filter(Boolean)),
  ].sort();
  const factories = [
    ...new Set(
      rows.map((r) => r.keys.find((k) => k.aName === 'FactoryCode')?.bVal || '').filter(Boolean),
    ),
  ].sort();
  const developers = [
    ...new Set(rows.map((r) => r.responsibleDeveloper || '').filter(Boolean)),
  ].sort();
  const mscCodes = [
    ...new Set(rows.map((r) => r.mscCode || '').filter(Boolean)),
  ].sort();
  const merTeams = merTeamOptions(rows);

  // "All" is active when NO category is selected — i.e. everything passes through.
  const allActive = activeFilters.size === 0;

  // Is there anything for the "Clear Filters" button to reset?
  const anyFilterActive =
    !allActive || !!search || !!seasonFilter || !!factoryFilter || !!merTeamFilter ||
    !!developerFilter || !!mscCodeFilter;

  return (
    <div className="results-toolbar">
      {/* Row 1 — counts on the left, Save / Export on the right */}
      <div className="toolbar-row">
        {/* Stat pills — counts are of the *filtered* rows so they respond to search / dropdowns */}
        <div className="stat-pill">
          <span className="dot" style={{ background: 'var(--match)' }} /> Match{' '}
          <span>{matchCount}</span>
        </div>
        <div className="stat-pill">
          <span className="dot" style={{ background: 'var(--mismatch)' }} /> Diff{' '}
          <span>{diffCount}</span>
        </div>
        <div className="stat-pill">
          <span className="dot" style={{ background: 'var(--only)' }} /> No Key{' '}
          <span>{noKeyCount}</span>
        </div>
        {notComparedCount > 0 && (
          <div className="stat-pill" title="Quoted in a currency the validator does not compare">
            <span className="dot" style={{ background: 'var(--notcompared)' }} /> Not Compared{' '}
            <span>{notComparedCount}</span>
          </div>
        )}
        <div className="stat-pill">
          Showing <span>{filteredCount}</span>
        </div>
        <div className="toolbar-actions">
          {dirty && (
            <span
              style={{
                fontSize: '.72rem',
                color: 'var(--only)',
                alignSelf: 'center',
                whiteSpace: 'nowrap',
              }}
              title="You have unsaved changes — click Save"
            >
              ● Unsaved
            </span>
          )}
          <button
            className="btn btn-primary"
            style={{ padding: '5px 13px' }}
            onClick={onSave}
            disabled={saving || !canEdit}
            title={
              canEdit
                ? 'Save Error From / Done — shared with everyone'
                : 'Read-only — ask an admin for edit access'
            }
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-ghost" style={{ padding: '5px 13px' }} onClick={onExport}>
            Export CSV
          </button>
        </div>
      </div>

      {/* Row 2 — every filter together, ending with Clear Filters.
          "All" clears the verdict set; the others toggle their category. */}
      <div className="toolbar-row">
        <div className="filter-btns">
          <button
            className={`filter-btn${allActive ? ' active' : ''}`}
            onClick={clearFilters}
            title="Clear all category filters"
          >
            All
          </button>
          {(['match', 'diff', 'nokey', 'notcompared'] as FilterCategory[]).map((c) => {
            const active = activeFilters.has(c);
            const label =
              c === 'match' ? 'Match' : c === 'diff' ? 'Diff' : c === 'nokey' ? 'No Key' : 'Not Compared';
            return (
              <button
                key={c}
                className={`filter-btn${active ? ' active' : ''}`}
                onClick={() => toggleFilter(c)}
                title={active ? `Hide ${label}` : `Show ${label}`}
              >
                {label}
              </button>
            );
          })}
        </div>
        {/* Season dropdown — empty string means "all", any other value filters exactly */}
        <select
          className="filter-select"
          value={seasonFilter}
          onChange={(e) => setSeasonFilter(e.target.value)}
        >
          <option value="">All Seasons</option>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="filter-select"
          value={factoryFilter}
          onChange={(e) => setFactoryFilter(e.target.value)}
        >
          <option value="">All Factories</option>
          {factories.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
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
        {/* MSC Code filter — combined text field + dropdown (a native <datalist> combobox).
            Same logic as the Developer filter: type to free-filter or pick a suggestion;
            App.tsx matches case-insensitive substring on MSC_CODE. */}
        <input
          className="filter-select"
          list="msc-code-options"
          placeholder="All MSC Codes"
          value={mscCodeFilter}
          onChange={(e) => setMscCodeFilter(e.target.value)}
        />
        <datalist id="msc-code-options">
          {mscCodes.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {/* Developer filter — combined text field + dropdown (a native <datalist> combobox).
            Type to free-filter, or click to pick a suggestion. Empty = all; otherwise
            App.tsx matches case-insensitive substring on RESPONSIBLE_DEVELOPER. */}
        <input
          className="filter-select"
          list="developer-options"
          placeholder="All Developers"
          value={developerFilter}
          onChange={(e) => setDeveloperFilter(e.target.value)}
        />
        <datalist id="developer-options">
          {developers.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
        <input
          className="search-box"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* Full reset: verdict categories + dropdowns + combo fields + search.
            Dimmed when there is nothing to clear. */}
        <button
          className="btn btn-ghost"
          style={{
            padding: '5px 13px',
            opacity: anyFilterActive ? 1 : 0.45,
            cursor: anyFilterActive ? 'pointer' : 'default',
          }}
          disabled={!anyFilterActive}
          onClick={clearAllFilters}
          title="Reset all filters and search"
        >
          ✕ Clear Filters
        </button>
      </div>
    </div>
  );
}
