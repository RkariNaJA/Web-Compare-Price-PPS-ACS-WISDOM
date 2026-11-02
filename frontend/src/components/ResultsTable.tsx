/**
 * The main results grid. One tr per CompRow, up to the user-selected row limit
 * (default 100 — kept small so big validations don't lag the page; a dropdown
 * above the table raises it to 500/1000/3000/5000). Beyond the limit, the user
 * is told to increase it or Export CSV for the full dataset.
 *
 * Layout — two header rows describe grouped columns; the second row has the
 * sub-labels. When Costsheet is loaded (hasC=true), the WISDOM SIZE / WISDOM
 * FINAL FOB / WISDOM EXT SIZE FOB / Max Input Date columns appear. A "Master Data" group
 * (Team Mer, Created CBD by) sits right after the # column. The rightmost "ACS Match?" column
 * is position:sticky right so the verdict stays visible while the table scrolls.
 *
 * All colour classes (cell-match / cell-miss / cell-empty / cell-c / etc.) come
 * from global.css — this file just decides which class applies per cell.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { CompRow, RowAnnotation } from '../lib/types';
import { fobEq, verdictOf } from '../lib/comparison';
import RowDetailsModal from './RowDetailsModal';
import { PREFERRED_CURRENCY } from '../lib/constants';
import { NO_COSTSHEET, UNASSIGNED } from '../lib/merTeam';

interface Props {
  rows: CompRow[];               // already filtered by App
  hasC: boolean;                 // whether to render Costsheet columns
  // User-filled annotation columns (not DB-sourced), keyed by CompRow.rowKey.
  annotations: Record<string, RowAnnotation>;
  onErrorFromChange: (rowKey: string, value: string) => void;
  onDoneChange: (rowKey: string, done: boolean) => void;
  onRemarkChange: (rowKey: string, remark: string) => void;
  canEdit: boolean;              // false → the Error From / Done / Remark inputs are disabled (read-only user)
}

// Row-limit choices for the "Show first N" dropdown. Rendering cost scales
// linearly with rows × columns, so the default stays low for snappy loads.
const ROW_LIMIT_OPTIONS = [100, 500, 1000, 3000, 5000];
const DEFAULT_ROW_LIMIT = 100;

// Choices for the "Error From" dropdown. Rendered in a fixed <select> so all
// options stay visible for re-selecting; a leading "-" (stored as empty string
// = not assigned) is added in the markup before these.
const ERROR_FROM_OPTIONS = ['Developer', 'Wisdom', 'Customer'];

// Narrowest a column can be dragged (px).
const MIN_COL_W = 40;
// Widest a column may be on FIRST render — caps the auto-measured natural width so
// the table isn't so wide that the right-hand columns (e.g. "Changed On") sit off
// screen right after Validate. Users can still drag any column wider than this.
const MAX_COL_W = 150;

// Same cap the backend applies (annotations_db.REMARK_MAX_LEN).
const REMARK_MAX_LEN = 500;

// Free-text Remark input. Keeps the draft locally and only pushes it up on
// blur / Enter, so typing doesn't re-render every row of the table per keystroke.
// Escape reverts. `key` on the caller resets the draft when the saved value changes.
function RemarkCell({
  value,
  canEdit,
  onCommit,
}: {
  value: string;
  canEdit: boolean;
  onCommit: (v: string) => void;
}) {
  return (
    <input
      className="cell-input"
      type="text"
      defaultValue={value}
      maxLength={REMARK_MAX_LEN}
      placeholder={canEdit ? 'Add remark…' : ''}
      disabled={!canEdit}
      title={!canEdit ? 'Read-only — ask an admin for edit access' : value || undefined}
      onBlur={(e) => {
        if (e.currentTarget.value !== value) onCommit(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export default function ResultsTable({
  rows,
  hasC,
  annotations,
  onErrorFromChange,
  onDoneChange,
  onRemarkChange,
  canEdit,
}: Props) {
  // How many rows to actually put in the DOM. User-adjustable via the dropdown
  // above the table; deliberately NOT reset on re-validate so the user's choice sticks.
  const [displayLimit, setDisplayLimit] = useState(DEFAULT_ROW_LIMIT);
  const shown = rows.slice(0, displayLimit);
  // Diff / No Key row whose details pop-up is open (null = closed).
  const [detailRow, setDetailRow] = useState<CompRow | null>(null);

  // ── Resizable columns ─────────────────────────────────────────────────────
  // The table first renders with auto layout; once a data row exists we measure
  // each column's natural width, lock them into a <colgroup> (table-layout:
  // fixed), and let the user drag the right edge of any header cell.
  // +5 leaf columns before the sticky "ACS Match?" verdict: the user-filled
  // "Error From" / "Done" / "Remark", plus "Changed By" / "Changed On" attribution.
  const colCount = hasC ? 29 : 23; // leaf columns, must match the header rows below
  const tableRef = useRef<HTMLTableElement>(null);
  const [colWidths, setColWidths] = useState<number[] | null>(null);
  const dragRef = useRef<{ idx: number; startX: number; startW: number; lastW: number } | null>(
    null,
  );

  // Forget saved widths when the column set changes (Costsheet loaded/cleared).
  useLayoutEffect(() => setColWidths(null), [colCount]);

  useLayoutEffect(() => {
    if (colWidths) return;
    const firstRow = tableRef.current?.tBodies[0]?.rows[0];
    if (!firstRow || firstRow.cells.length !== colCount) return;
    setColWidths(Array.from(firstRow.cells).map((c) => Math.min(c.offsetWidth, MAX_COL_W)));
  }, [colWidths, colCount, shown.length]);

  // Header cells are sticky individually, so row 2 must stick just below row 1.
  // Row 1 never wraps (nowrap), so measuring once per layout change is enough.
  useLayoutEffect(() => {
    const table = tableRef.current;
    const row1 = table?.tHead?.rows[0];
    if (table && row1) table.style.setProperty('--hdr-row1-h', `${row1.getBoundingClientRect().height}px`);
  }, [hasC, colWidths]);

  // ── Horizontal scrolling ──────────────────────────────────────────────────
  // The table is much wider than the screen, and .table-wrap's own scrollbar
  // sits at the bottom of the panel. A mirrored slider bar above the table is
  // kept in sync with .table-wrap's scrollLeft so the user can drag it without
  // hunting for the bottom edge. Mouse wheel over the slider bar or the header
  // rows scrolls sideways (Shift+wheel works anywhere, natively).
  const wrapRef = useRef<HTMLDivElement>(null);
  const hbarRef = useRef<HTMLDivElement>(null);
  const [scrollW, setScrollW] = useState(0);
  const [viewW, setViewW] = useState(0);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const table = tableRef.current;
    if (!wrap || !table) return;
    const measure = () => {
      setScrollW(wrap.scrollWidth);
      setViewW(wrap.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    ro.observe(table);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const hbar = hbarRef.current;
    const thead = tableRef.current?.tHead;
    if (!wrap || !hbar) return;
    // Guard flag stops the two scroll handlers from echoing each other.
    let syncing = false;
    const fromWrap = () => {
      if (syncing) { syncing = false; return; }
      syncing = true;
      hbar.scrollLeft = wrap.scrollLeft;
    };
    const fromBar = () => {
      if (syncing) { syncing = false; return; }
      syncing = true;
      wrap.scrollLeft = hbar.scrollLeft;
    };
    // Non-passive so preventDefault can stop the vertical scroll.
    const wheelSideways = (e: WheelEvent) => {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // already horizontal
      e.preventDefault();
      wrap.scrollLeft += e.deltaY;
    };
    wrap.addEventListener('scroll', fromWrap);
    hbar.addEventListener('scroll', fromBar);
    hbar.addEventListener('wheel', wheelSideways, { passive: false });
    thead?.addEventListener('wheel', wheelSideways, { passive: false });
    return () => {
      wrap.removeEventListener('scroll', fromWrap);
      hbar.removeEventListener('scroll', fromBar);
      hbar.removeEventListener('wheel', wheelSideways);
      thead?.removeEventListener('wheel', wheelSideways);
    };
  }, [scrollW > viewW]);

  // Drag handle rendered inside a header cell; `col` is the colgroup index
  // whose right edge this handle moves. Pointer capture keeps the drag alive
  // even when the cursor leaves the 6px strip. During the drag we mutate the
  // <col> width directly (re-rendering 2000 React rows per mousemove would
  // lag); the final width is committed to state on release.
  const endDrag = () => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setColWidths((prev) => (prev ? prev.map((v, i) => (i === d.idx ? d.lastW : v)) : prev));
  };
  const resizer = (col: number) => (
    <span
      className="col-resizer"
      onPointerDown={(e) => {
        if (!colWidths) return;
        e.preventDefault();
        dragRef.current = { idx: col, startX: e.clientX, startW: colWidths[col], lastW: colWidths[col] };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        const table = tableRef.current;
        if (!d || !table || !colWidths) return;
        d.lastW = Math.max(MIN_COL_W, d.startW + e.clientX - d.startX);
        const colEl = table.getElementsByTagName('col')[d.idx];
        if (colEl) colEl.style.width = `${d.lastW}px`;
        const total = colWidths.reduce((a, b, i) => a + (i === d.idx ? d.lastW : b), 0);
        table.style.width = `${total}px`;
        table.style.minWidth = `${total}px`;
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );

  // Leaf-column indices that shift depending on whether Costsheet is loaded.
  // Order matches the header rows.
  const ci = {
    used: hasC ? 13 : 12,
    ppsFinal: hasC ? 14 : 13,
    ppsExt: hasC ? 15 : 14,
    acsFinal: hasC ? 16 : 15,
    acsExt: hasC ? 17 : 16,
  };

  const totalW = colWidths ? colWidths.reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      {/* Row-limit bar — keeps the DOM small by default (100 rows) so large
          validations stay responsive. Sits outside .table-wrap so it doesn't
          scroll away with the table. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 24px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          flexShrink: 0,
          fontSize: '.78rem',
          color: 'var(--muted)',
        }}
      >
        <span>Show first</span>
        <select
          className="filter-select"
          value={displayLimit}
          onChange={(e) => setDisplayLimit(Number(e.target.value))}
        >
          {ROW_LIMIT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()}
            </option>
          ))}
        </select>
        <span>
          rows — displaying <strong style={{ color: 'var(--text)' }}>{shown.length.toLocaleString()}</strong> of{' '}
          <strong style={{ color: 'var(--text)' }}>{rows.length.toLocaleString()}</strong>
          {rows.length > displayLimit && ' (higher limits may slow the page)'}
        </span>
      </div>
      {scrollW > viewW && (
        <div className="table-hscroll" ref={hbarRef} title="Drag or use the mouse wheel to scroll columns">
          <div style={{ width: scrollW, height: 1 }} />
        </div>
      )}
      <div className="table-wrap" ref={wrapRef}>
      <table
        className={`result${colWidths ? ' resizable' : ''}`}
        ref={tableRef}
        style={colWidths ? { tableLayout: 'fixed', width: totalW, minWidth: totalW } : undefined}
      >
        {colWidths && (
          <colgroup>
            {colWidths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
        )}
        <thead>
          {/* Header row 1 — top-level column groupings. rowSpan cells cross both rows. */}
          <tr>
            <th className="hrow" rowSpan={2}>#{resizer(0)}</th>
            <th className="hm grp" colSpan={2}>Master Data</th>
            <th className="hb" rowSpan={2}>MSC_CODE{resizer(3)}</th>
            <th className="hb" rowSpan={2}>RESPONSIBLE_DEVELOPER{resizer(4)}</th>
            <th className="ha" colSpan={5}>🔑 Key Columns</th>
            {/* Size Comparison spans 2 columns by default, 3 when Costsheet is loaded */}
            <th className="hlogic grp" colSpan={hasC ? 3 : 2}>Size Comparison</th>
            <th className="hlogic grp">FOB Source</th>
            <th className="hb grp">PPS FINAL FOB</th>
            <th className="hb grp">PPS EXT SIZE FOB</th>
            <th className="ha grp">ACS FINAL FOB</th>
            <th className="ha grp">ACS EXT SIZE FOB</th>
            {hasC && (
              <>
                <th className="hc grp">WISDOM FINAL FOB</th>
                <th className="hc grp">WISDOM EXT SIZE FOB</th>
                <th className="hc" rowSpan={2}>Version{resizer(20)}</th>
                <th className="hc" rowSpan={2}>Cost Sheet No{resizer(21)}</th>
                <th className="hc">Max Input Date</th>
              </>
            )}
            {/* User-filled columns + save attribution, just before the verdict.
                Leaf indices: Error From colCount-6, Done -5, Remark -4, Changed By -3, Changed On -2. */}
            <th className="hrow grp" rowSpan={2}>Error From{resizer(colCount - 6)}</th>
            <th className="hrow" rowSpan={2}>Done{resizer(colCount - 5)}</th>
            <th className="hrow" rowSpan={2}>Remark{resizer(colCount - 4)}</th>
            <th className="hrow grp" rowSpan={2}>Changed By{resizer(colCount - 3)}</th>
            <th className="hrow" rowSpan={2}>Changed On{resizer(colCount - 2)}</th>
            {/* ACS Match? is sticky-right + spans both header rows */}
            <th className="hrow grp sticky-end" rowSpan={2}>ACS Match?{resizer(colCount - 1)}</th>
          </tr>
          {/* Header row 2 — sub-labels for each grouped column */}
          <tr>
            <th className="hm grp">Team Mer{resizer(1)}</th>
            <th className="hm">Created CBD by{resizer(2)}</th>
            <th className="ha">Season{resizer(5)}</th>
            <th className="ha">Size{resizer(6)}</th>
            <th className="ha">Style{resizer(7)}</th>
            <th className="ha">Color{resizer(8)}</th>
            <th className="ha">Factory{resizer(9)}</th>
            <th className="hlogic grp">PPS SIZE{resizer(10)}</th>
            <th className="hlogic">ACS CBDID SIZE{resizer(11)}</th>
            {hasC && <th className="hc">WISDOM SIZE{resizer(12)}</th>}
            <th className="hlogic grp">Used{resizer(ci.used)}</th>
            <th className="hb grp">Value{resizer(ci.ppsFinal)}</th>
            <th className="hb grp">Value{resizer(ci.ppsExt)}</th>
            <th className="ha grp">Value{resizer(ci.acsFinal)}</th>
            <th className="ha grp">Value{resizer(ci.acsExt)}</th>
            {hasC && (
              <>
                <th className="hc grp">Value{resizer(18)}</th>
                <th className="hc grp">Value{resizer(19)}</th>
                <th className="hc">Max Date{resizer(22)}</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => {
            // Derived flags used to choose which cell classes to apply
            const isMatch = row.valueMatch;
            const isNoKey = row.status === 'noKeyMatch';
            // Quoted in a currency the validator doesn't compare (e.g. THB) — no
            // comparison was performed, so cells must not claim agreement OR disagreement.
            const isNotCompared = verdictOf(row) === 'notCompared';
            // Saved annotation for this row (by stable rowKey); undefined if none.
            const ann = annotations[row.rowKey];

            // PPS SIZE vs ACS CBDID SIZE — green when they match, red otherwise
            const szMatch = row.bSize.toLowerCase() === row.dbCbdidSize.toLowerCase();
            const szCls = szMatch ? 'cell-match' : 'cell-miss';

            // WISDOM SIZE colouring — only relevant when Costsheet loaded AND a costsheet row was matched
            const wSzMatchCls = (() => {
              if (!hasC) return '';
              if (!row.cMatched) return 'cell-empty';
              const eq = (row.cSizeNorm || '').toLowerCase() === (row.bSize || '').toLowerCase();
              return eq ? 'cell-match' : 'cell-miss';
            })();

            // ACS FOB + PPS FOB cell classes — both driven by the same 3-way verdict.
            // (Green on Match, red on Diff, muted-grey on NoKey, muted-violet on NotCompared —
            // neither claims agreement nor disagreement, since no comparison ran for either,
            // but NotCompared gets its own token so it reads as "currency-skipped", not "key
            // problem".)
            const dbCls = isMatch ? 'cell-match' : isNoKey ? 'cell-empty' : isNotCompared ? 'cell-notcompared' : 'cell-miss';
            const lqCls = dbCls;
            // PPS has ONE price per row (LOCAL_QUOTE_AMOUNT). It goes in PPS EXT SIZE FOB when
            // the PPS size is in the extended group (ALL_EXTEND_SIZE_RB), otherwise in PPS
            // FINAL FOB (regular sizes, and sizes in neither list). The other column is "—".
            const ppsExt = row.bSize === 'ALL_EXTEND_SIZE_RB';
            const ppsCell = (extCol: boolean) =>
              extCol === ppsExt ? (
                <td className={`grp ${lqCls}`}>
                  {row.localQuoteVal || '—'}
                  {row.currency && row.currency.toUpperCase() !== PREFERRED_CURRENCY && (
                    <span style={{ opacity: 0.6, marginLeft: 4, fontSize: '.85em' }}>
                      {row.currency}
                    </span>
                  )}
                </td>
              ) : (
                <td className="grp">—</td>
              );
            // ACS FINAL FOB / EXT SIZE FOB cells — both values shown, but only the column
            // ACS priced from (fobSource, picked by PPS size vs CBDID size) carries the
            // verdict colour; the other stays plain, same rule as the WISDOM pair.
            // No Key rows have no ACS row, so both are grey. On a THB row the values are
            // ACS's local (THB) prices; if ACS has none, the picked column reads "not compared".
            const acsFobCls = (src: CompRow['fobSource']): string => {
              if (isNoKey) return 'cell-empty';
              if (row.fobSource !== src) return '';
              return row.acsCompared ? dbCls : 'cell-notcompared';
            };

            // WISDOM FINAL FOB / EXT SIZE FOB cells — display-only (the verdict still
            // uses the size-picked cFobValue). Only the column the WISDOM size picks
            // gets a colour (Ext Size FOB for an extended size, Final FOB otherwise);
            // the other one stays plain so users don't read it as part of the check.
            // Green only when the value equals PPS FOB and ACS FOB too (when ACS took part);
            // on a THB row (l4l) all three are local (THB) prices. Blank or No Key rows have
            // nothing to compare.
            const wFobCls = (v: string, isExtCol: boolean): string => {
              if (isExtCol !== row.cIsExt) return '';
              if (isNotCompared) return 'cell-notcompared';
              if (!v || isNoKey) return 'cell-empty';
              const ok = fobEq(v, row.localQuoteVal) && (!row.acsCompared || fobEq(v, row.dbFobValue));
              return ok ? 'cell-match' : 'cell-miss';
            };
            // Small currency tag after an ACS / WISDOM value when it is the local (THB) price.
            const l4lTag = row.l4l ? (
              <span style={{ opacity: 0.6, marginLeft: 4, fontSize: '.85em' }}>{row.currency}</span>
            ) : null;

            // Small pill in the "FOB Source" column showing which ACS FOB was used.
            const fobTagCls =
              row.fobSource === 'FinalFOB'
                ? 'fob-tag final'
                : row.fobSource === 'ExtSzFOB'
                ? 'fob-tag ext'
                : 'fob-tag no-match';
            const fobTagText =
              row.fobSource === 'FinalFOB'
                ? 'Final FOB'
                : row.fobSource === 'ExtSzFOB'
                ? 'ExtSzFOB'
                : 'N/A';

            // Build the rightmost "ACS Match?" cell content — 3 possible states:
            //   • noKeyMatch → warning + "details ›" (pop-up: join key, ACS colours, ...)
            //   • match      → green ✓ badge
            //   • diff       → red ✗ badge + reason chips + "details ›" (pop-up breakdown)
            let acsResultNode: React.ReactNode;
            if (isNoKey) {
              // The diagnostic (missing sides, join key, the colours ACS does have)
              // lives in RowDetailsModal so this sticky verdict column stays narrow.
              acsResultNode = (
                <>
                  <span style={{ color: 'var(--only)' }}>⚠ No Key Match</span>
                  <button
                    type="button"
                    className="dd-open"
                    onClick={() => setDetailRow(row)}
                  >
                    details ›
                  </button>
                </>
              );
            } else if (isNotCompared) {
              // Quoted in a currency the validator does not compare (e.g. THB) — its own
              // --notcompared token, not the red badge-miss styling and not --only (which
              // means "No Key" elsewhere), since no comparison ran at all for this row.
              acsResultNode = (
                <span
                  style={{ color: 'var(--notcompared)' }}
                  title="Quoted in a currency the validator does not compare"
                >
                  — not compared
                </span>
              );
            } else if (isMatch) {
              acsResultNode = (
                <>
                  <span className="badge-match" />
                  <span style={{ color: 'var(--match)' }}>✓ Match</span>
                </>
              );
            } else {
              // Diff — figure out which of the 3 sources disagreed so the user has a hint.
              // When both sides are numeric, append the delta (PPS minus the other source,
              // so "+" means PPS is higher). Rounded to 4 decimals to hide float noise.
              const fmtDiff = (pps: string, other: string): string => {
                const x = parseFloat(pps);
                const y = parseFloat(other);
                if (isNaN(x) || isNaN(y)) return '';
                const d = Math.round((x - y) * 10000) / 10000;
                return ` (${d > 0 ? '+' : ''}${d})`;
              };
              // ACS only counts when it took part (USD rows); on THB rows the WISDOM
              // check is against its L4L price, and a blank L4L cell means "no THB price".
              const reasons: string[] = [];
              if (row.acsCompared && row.lqVsAcs === false)
                reasons.push(
                  `PPS!=ACS${row.l4l ? ' THB' : ''}${fmtDiff(row.localQuoteVal, row.dbFobValue)}`,
                );
              if (hasC && row.cMatched && row.cMatch === false) {
                if (row.l4l && !row.cFobValue) reasons.push('No WISDOM THB price');
                else
                  reasons.push(
                    `PPS!=WISDOM${row.l4l ? ' THB' : ''}${fmtDiff(row.localQuoteVal, row.cFobValue)}`,
                  );
              }
              if (hasC && !row.cMatched) reasons.push('No WISDOM');

              acsResultNode = (
                <>
                  <span className="badge-miss" />
                  <span style={{ color: 'var(--mismatch)' }}>✗ Diff</span>
                  {reasons.length > 0 && (
                    <div
                      style={{ color: 'var(--text)', fontSize: '.65rem', marginTop: 2 }}
                    >
                      {reasons.join(' · ')}
                    </div>
                  )}
                  <button
                    type="button"
                    className="dd-open"
                    onClick={() => setDetailRow(row)}
                  >
                    details ›
                  </button>
                </>
              );
            }

            // Render the actual row. Columns are in the same order as the header rows.
            return (
              <tr key={row.rowIdx}>
                <td className="row-num">{row.rowIdx}</td>
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
                {/* MSC_CODE + RESPONSIBLE_DEVELOPER — display-only values taken straight
                    from the uploaded PPS "File Compare". Shown before the key columns.
                    Full value available on hover via title. */}
                <td title={row.mscCode}>{row.mscCode || '—'}</td>
                <td title={row.responsibleDeveloper}>{row.responsibleDeveloper || '—'}</td>
                {/* Key columns — 5 cells, one per KEY_PAIRS entry.
                    Green if this key matched between ACS and PPS, yellow-ish otherwise.
                    Hover reveals both values via the title attribute. */}
                {row.keys.map((k, i) => {
                  const cls = isNoKey ? 'cell-key-miss' : k.match ? 'cell-key-match' : 'cell-key-miss';
                  return (
                    <td key={i} className={cls} title={`A: ${k.aVal} | B: ${k.bVal}`}>
                      {k.bVal || '—'}
                    </td>
                  );
                })}
                {/* Size Comparison group: PPS size / ACS size / (WISDOM size if loaded) */}
                <td className={`grp ${isNoKey ? 'cell-empty' : szCls}`}>{row.bSize || '—'}</td>
                <td className={isNoKey ? 'cell-empty' : szCls}>{row.dbCbdidSize || '—'}</td>
                {hasC && (
                  <td className={wSzMatchCls}>
                    {row.cMatched ? row.cSizeVal || '—' : '—'}
                  </td>
                )}
                {/* FOB source pill (Final FOB / ExtSzFOB / N/A) */}
                <td className="grp" style={{ textAlign: 'center' }}>
                  <span className={fobTagCls}>{fobTagText}</span>
                </td>
                {/* PPS Final / Ext Size FOB (one holds LOCAL_QUOTE_AMOUNT, by PPS size) + ACS
                    Final / Ext Size FOB (coloured by the 3-way verdict; for ACS only the
                    size-picked column) */}
                {ppsCell(false)}
                {ppsCell(true)}
                <td className={`grp ${acsFobCls('FinalFOB')}`}>
                  {row.dbFinalFobValue || '—'}
                  {row.dbFinalFobValue && l4lTag}
                </td>
                <td className={`grp ${acsFobCls('ExtSzFOB')}`}>
                  {row.dbExtFobValue || '—'}
                  {row.dbExtFobValue && l4lTag}
                </td>
                {/* Costsheet columns: WISDOM Final FOB + Ext Size FOB + Version + Cost Sheet No + Max Input Date.
                    Only when File C is loaded. If no CS row matched, show em-dashes. */}
                {hasC && (
                  <>
                    {row.cMatched ? (
                      <>
                        <td className={`grp ${wFobCls(row.cFinalFobValue, false)}`}>
                          {row.cFinalFobValue || '—'}
                          {row.cFinalFobValue && l4lTag}
                        </td>
                        <td className={`grp ${wFobCls(row.cExtFobValue, true)}`}>
                          {row.cExtFobValue || '—'}
                          {row.cExtFobValue && l4lTag}
                        </td>
                        <td className="cell-c">{row.cVersionVal || '—'}</td>
                        <td className="cell-c">{row.cCostSheetNo || '—'}</td>
                        <td className="cell-c">{row.cDateStr || '—'}</td>
                      </>
                    ) : (
                      <>
                        <td className="grp cell-empty">—</td>
                        <td className="grp cell-empty">—</td>
                        <td className="cell-empty">—</td>
                        <td className="cell-empty">—</td>
                        <td className="cell-empty">—</td>
                      </>
                    )}
                  </>
                )}
                {/* User-filled columns — NOT from any data source. "Error From"
                    is a fixed dropdown; "Done" is a checkbox; "Remark" is free text. Keyed by the stable
                    rowKey, saved to the backend, and included in the CSV export.
                    The Error From cell's tooltip shows who last saved it. */}
                <td
                  className="grp"
                  title={
                    ann?.savedBy
                      ? `Saved by ${ann.savedBy}${ann.savedAt ? ' · ' + ann.savedAt.slice(0, 10) : ''}`
                      : undefined
                  }
                >
                  <select
                    className="cell-select"
                    value={ann?.errorFrom ?? ''}
                    onChange={(e) => onErrorFromChange(row.rowKey, e.target.value)}
                    disabled={!canEdit}
                    title={!canEdit ? 'Read-only — ask an admin for edit access' : undefined}
                  >
                    {/* "-" = not assigned; stored as '' so the CSV stays blank */}
                    <option value="">-</option>
                    {ERROR_FROM_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input
                    className="cell-check"
                    type="checkbox"
                    checked={ann?.done ?? false}
                    onChange={(e) => onDoneChange(row.rowKey, e.target.checked)}
                    disabled={!canEdit}
                    title={!canEdit ? 'Read-only — ask an admin for edit access' : undefined}
                  />
                </td>
                <td>
                  <RemarkCell
                    key={`${row.rowKey}|${ann?.remark ?? ''}`}
                    value={ann?.remark ?? ''}
                    canEdit={canEdit}
                    onCommit={(v) => onRemarkChange(row.rowKey, v)}
                  />
                </td>
                {/* Save attribution — who last changed this row and on what date.
                    Populated from the backend on Save; blank ("—") for unsaved rows. */}
                <td className="grp">{ann?.savedBy || '—'}</td>
                <td title={ann?.savedAt || undefined}>
                  {ann?.savedAt ? ann.savedAt.slice(0, 10) : '—'}
                </td>
                {/* Sticky-right verdict cell — always visible thanks to position:sticky */}
                <td className="grp sticky-end">{acsResultNode}</td>
              </tr>
            );
          })}
          {/* Overflow hint when the result set exceeds the selected row limit */}
          {rows.length > displayLimit && (
            <tr>
              <td
                colSpan={99}
                style={{
                  textAlign: 'center',
                  color: 'var(--muted)',
                  padding: 12,
                  fontSize: '.73rem',
                }}
              >
                Showing {displayLimit.toLocaleString()} of {rows.length.toLocaleString()} rows —
                increase the row limit above or export CSV for full data
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      {detailRow && (
        <RowDetailsModal row={detailRow} hasC={hasC} onClose={() => setDetailRow(null)} />
      )}
    </>
  );
}
