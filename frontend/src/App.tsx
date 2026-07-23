/**
 * Root component. Owns all the top-level state (loaded data + filters + comparison result)
 * and composes the four main panels: Header · UploadStrip · KeyInfoPanel · Results.
 *
 * The comparison itself lives in src/lib/comparison.ts — App just decides WHEN to run it
 * (on Validate click) and what to do with the result (store, filter, render, export).
 */
import { useCallback, useMemo, useState } from 'react';
import Header from './components/Header';
import UploadStrip from './components/UploadStrip';
import KeyInfoPanel from './components/KeyInfoPanel';
import ResultsToolbar, { type FilterCategory } from './components/ResultsToolbar';
import ResultsTable from './components/ResultsTable';
import { ToastProvider, useToast } from './hooks/useToast';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { usePresenceHeartbeat } from './hooks/usePresenceHeartbeat';
import LoginPage from './components/LoginPage';
import GroupAdmin from './components/GroupAdmin';
import LogDashboard from './components/LogDashboard';
import SummaryDashboard from './components/SummaryDashboard';
import { runComparison } from './lib/comparison';
import { exportComparisonCSV } from './lib/csv';
import { fetchAnnotations, saveAnnotations } from './lib/api';
import type { AppView, CompRow, PPSFile, RowAnnotation, TableData } from './lib/types';

function AppInner() {
  const toast = useToast();
  const { user } = useAuth();
  const canEdit = !!user?.perms?.can_edit;
  usePresenceHeartbeat();
  const canManage = !!user?.perms?.can_manage;
  const [view, setView] = useState<AppView>(canManage ? 'menu' : 'compare');

  // ── Source data (populated by the upload strip) ────────────────────────────
  const [dataA, setDataA] = useState<TableData | null>(null);         // ACS from DB
  const [dataC, setDataC] = useState<TableData | null>(null);         // Costsheet from DB (optional)
  const [dataBFiles, setDataBFiles] = useState<PPSFile[]>([]);        // PPS DB data, one entry per factory

  // ── Comparison result (populated on Validate) ──────────────────────────────
  const [compRows, setCompRows] = useState<CompRow[]>([]);
  // Snapshot of "was Costsheet loaded when Validate ran" — used for header layout
  // and CSV columns. Prevents the UI from flickering if the user clears Costsheet
  // AFTER validating but BEFORE re-running.
  const [hadResultC, setHadResultC] = useState(false);

  // ── User-filled annotations (Error From / Done), saved to the backend ───────
  // Keyed by CompRow.rowKey (a STABLE id), so the same value maps to the same
  // logical row for every user and survives re-validation. Loaded from the server
  // on Validate, written back by the Save button. `dirty` = unsaved local edits.
  const [annotations, setAnnotations] = useState<Record<string, RowAnnotation>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);

  const setErrorFrom = useCallback((rowKey: string, errorFrom: string) => {
    setAnnotations((prev) => ({
      ...prev,
      [rowKey]: { ...prev[rowKey], errorFrom, done: prev[rowKey]?.done ?? false },
    }));
    setDirty(true);
  }, []);

  const setDone = useCallback((rowKey: string, done: boolean) => {
    setAnnotations((prev) => ({
      ...prev,
      [rowKey]: { ...prev[rowKey], done, errorFrom: prev[rowKey]?.errorFrom ?? '' },
    }));
    setDirty(true);
  }, []);

  // Pull the shared saved values from the backend (called after Validate). Maps
  // onto the current rows by rowKey; overwrites any unsaved local edits.
  const loadAnnotations = useCallback(() => {
    fetchAnnotations()
      .then((saved) => {
        setAnnotations(saved);
        setDirty(false);
      })
      .catch((err) => toast(`Could not load saved data: ${(err as Error).message}`, 'err'));
  }, [toast]);

  // Save button — write the current values to the backend, then refresh from the
  // returned set so saved_by / saved_at update and cleared rows drop out.
  const handleSave = useCallback(() => {
    setSaving(true);
    saveAnnotations(annotations)
      .then((saved) => {
        setAnnotations(saved);
        setDirty(false);
        toast('Saved', 'ok');
      })
      .catch((err) => toast(`Save failed: ${(err as Error).message}`, 'err'))
      .finally(() => setSaving(false));
  }, [annotations, toast]);

  // ── Filter state for the results table ─────────────────────────────────────
  // activeFilters is a Set of verdict categories. Empty set = show everything;
  // any non-empty set filters rows to those matching ANY active category (OR).
  const [activeFilters, setActiveFilters] = useState<Set<FilterCategory>>(new Set());
  const [search, setSearch] = useState('');
  const [seasonFilter, setSeasonFilter] = useState('');
  const [factoryFilter, setFactoryFilter] = useState('');
  const [developerFilter, setDeveloperFilter] = useState('');
  const [mscCodeFilter, setMscCodeFilter] = useState('');

  // Toggle one category in/out of the set. Always creates a new Set so React re-renders.
  const toggleFilter = useCallback((c: FilterCategory) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);

  // "All" button resets to empty (= show everything).
  const clearFilters = useCallback(() => setActiveFilters(new Set()), []);

  // "Clear Filters" button — full reset: verdict categories, dropdowns,
  // combo fields, and the search box all back to their defaults.
  const clearAllFilters = useCallback(() => {
    setActiveFilters(new Set());
    setSearch('');
    setSeasonFilter('');
    setFactoryFilter('');
    setDeveloperFilter('');
    setMscCodeFilter('');
  }, []);

  // Guards for showing the Validate button and the KeyInfo panel.
  const canValidate = dataA !== null && dataBFiles.length > 0;
  const keyPanelVisible = canValidate;

  // ── Validate button handler ────────────────────────────────────────────────
  // Runs the pure runComparison() and stores the result. Any thrown error
  // (missing ACS columns, etc.) becomes an error toast; warnings from the
  // comparison also toast individually.
  const handleValidate = () => {
    if (!dataA) {
      toast('Load ACS DB data first', 'err');
      return;
    }
    if (!dataBFiles.length) {
      toast('Load at least one PPS factory from DB', 'err');
      return;
    }
    try {
      const result = runComparison(dataA, dataBFiles, dataC);
      setCompRows(result.rows);
      setHadResultC(dataC !== null);
      // Pull the shared saved Error From / Done from the backend and map them
      // onto the freshly-built rows by rowKey.
      loadAnnotations();
      result.warnings.forEach((w) => toast(w, 'err'));
      const dupNote =
        result.collapsedRows > 0
          ? ` · ${result.collapsedRows.toLocaleString()} duplicate rows collapsed`
          : '';
      toast(
        `Done — ${result.matchCount} ACS match · ${result.diffCount} diff · ${result.noKeyCount} no key match${dupNote}`,
        'ok',
      );
    } catch (err) {
      toast((err as Error).message, 'err');
    }
  };

  // ── Filtered view of compRows ──────────────────────────────────────────────
  // useMemo so the filter chain only runs when its inputs change — the table
  // can be scrolled without recomputing on every render.
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    let rows = compRows;
    // Verdict filter — OR across active categories. Empty set means no filter (show all).
    if (activeFilters.size > 0) {
      rows = rows.filter((r) => {
        if (activeFilters.has('match') && r.valueMatch) return true;
        if (activeFilters.has('diff') && r.status === 'matched' && !r.valueMatch) return true;
        if (activeFilters.has('nokey') && r.status === 'noKeyMatch') return true;
        return false;
      });
    }
    // Dropdown filters
    if (seasonFilter) {
      rows = rows.filter(
        (r) => (r.keys.find((k) => k.aName === 'Season')?.bVal || '') === seasonFilter,
      );
    }
    if (factoryFilter) {
      rows = rows.filter(
        (r) => (r.keys.find((k) => k.aName === 'FactoryCode')?.bVal || '') === factoryFilter,
      );
    }
    // Developer / MSC Code combo fields: case-insensitive substring so partial
    // typing works, while selecting a full suggestion from the datalist still
    // matches exactly.
    const devQ = developerFilter.toLowerCase().trim();
    if (devQ) {
      rows = rows.filter((r) => r.responsibleDeveloper.toLowerCase().includes(devQ));
    }
    const mscQ = mscCodeFilter.toLowerCase().trim();
    if (mscQ) {
      rows = rows.filter((r) => r.mscCode.toLowerCase().includes(mscQ));
    }
    // Freeform search across keys, FOB values, MSC/developer, filename, and CS FOB
    if (q) {
      rows = rows.filter(
        (r) =>
          r.keys.some(
            (k) => k.aVal.toLowerCase().includes(q) || k.bVal.toLowerCase().includes(q),
          ) ||
          r.localQuoteVal.toLowerCase().includes(q) ||
          r.dbFobValue.toLowerCase().includes(q) ||
          r.mscCode.toLowerCase().includes(q) ||
          r.responsibleDeveloper.toLowerCase().includes(q) ||
          r.srcFile.toLowerCase().includes(q) ||
          (r.cFobValue || '').toLowerCase().includes(q),
      );
    }
    return rows;
  }, [compRows, activeFilters, search, seasonFilter, factoryFilter, developerFilter, mscCodeFilter]);

  // Counts reflect the *filtered* rows so the toolbar stats respond to the filters.
  const matchCount = filtered.filter((r) => r.valueMatch).length;
  const diffCount = filtered.filter((r) => r.status === 'matched' && !r.valueMatch).length;
  const noKeyCount = filtered.filter((r) => r.status === 'noKeyMatch').length;

  const showResults = compRows.length > 0;

  const header = (
    <Header onOpenGroups={() => setAdminOpen(true)} view={view} onSetView={setView} />
  );

  if (adminOpen) {
    return (
      <div className="app">
        {header}
        <GroupAdmin onClose={() => setAdminOpen(false)} />
      </div>
    );
  }

  if (view === 'menu') {
    return (
      <div className="app">
        {header}
        <div className="landing">
          <div className="landing-heading">
            <h2>Welcome{user?.display_name ? `, ${user.display_name}` : ''}</h2>
            <p>Choose where you'd like to go.</p>
          </div>
          <div className="landing-cards">
            <button className="landing-card" onClick={() => setView('log')}>
              <span className="lc-icon">☰</span>
              <span className="lc-title">Dashboard · Log</span>
              <span className="lc-sub">
                Who's online now, logins by week, and the full history of who changed what.
              </span>
            </button>
            <button className="landing-card" onClick={() => setView('compare')}>
              <span className="lc-icon">⊞</span>
              <span className="lc-title">Dashboard · Compare Data</span>
              <span className="lc-sub">The 3-way PPS · ACS · WISDOM validator.</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'log') {
    return (
      <div className="app">
        {header}
        <LogDashboard />
      </div>
    );
  }

  if (view === 'summary') {
    return (
      <div className="app">
        {header}
        <SummaryDashboard rows={compRows} />
      </div>
    );
  }

  return (
    <div className="app">
      {header}
      <UploadStrip
        dataA={dataA}
        dataC={dataC}
        dataBFiles={dataBFiles}
        setDataA={setDataA}
        setDataC={setDataC}
        setDataBFiles={setDataBFiles}
      />
      <KeyInfoPanel
        visible={keyPanelVisible}
        canValidate={canValidate}
        onValidate={handleValidate}
      />

      {showResults ? (
        // Results panel — toolbar + table
        <div className="results-panel" style={{ display: 'flex' }}>
          <ResultsToolbar
            rows={compRows}
            filteredCount={filtered.length}
            matchCount={matchCount}
            diffCount={diffCount}
            noKeyCount={noKeyCount}
            activeFilters={activeFilters}
            toggleFilter={toggleFilter}
            clearFilters={clearFilters}
            search={search}
            setSearch={setSearch}
            seasonFilter={seasonFilter}
            setSeasonFilter={setSeasonFilter}
            factoryFilter={factoryFilter}
            setFactoryFilter={setFactoryFilter}
            developerFilter={developerFilter}
            setDeveloperFilter={setDeveloperFilter}
            mscCodeFilter={mscCodeFilter}
            setMscCodeFilter={setMscCodeFilter}
            clearAllFilters={clearAllFilters}
            // Export uses compRows (unfiltered) so the CSV always contains everything.
            onExport={() => exportComparisonCSV(compRows, hadResultC, annotations)}
            onSave={handleSave}
            saving={saving}
            dirty={dirty}
            canEdit={canEdit}
          />
          <ResultsTable
            rows={filtered}
            hasC={hadResultC}
            annotations={annotations}
            onErrorFromChange={setErrorFrom}
            onDoneChange={setDone}
            canEdit={canEdit}
          />
        </div>
      ) : (
        // Empty state — shown once ACS + PPS are loaded but Validate hasn't been clicked yet
        keyPanelVisible && (
          <div className="empty-state">
            <div className="icon">⊙</div>
            <h3>Ready to validate</h3>
            <p>
              Load ACS from DB, optionally load Costsheet, pick PPS factory(ies), then click{' '}
              <strong>Validate</strong>.
            </p>
          </div>
        )
      )}
    </div>
  );
}

// Decides what to show based on auth state: a loading placeholder during the
// initial /me check, the login page when signed out, or the app when signed in.
function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="login-wrap">
        <div className="login-card login-loading">Loading…</div>
      </div>
    );
  }
  return user ? <AppInner /> : <LoginPage />;
}

// The exported root injects ToastProvider (so useToast() works everywhere) and
// AuthProvider (so login gates the whole app), then hands off to AuthGate.
export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </ToastProvider>
  );
}
