/**
 * The main results grid. One tr per CompRow, up to the user-selected row limit
 * (default 100 — kept small so big validations don't lag the page; a dropdown
 * above the table raises it to 500/1000/3000/5000). Beyond the limit, the user
 * is told to increase it or Export CSV for the full dataset.
 *
 * Layout — two header rows describe grouped columns; the second row has the
 * sub-labels. When Costsheet is loaded (hasC=true), the WISDOM SIZE / WISDOM
 * FINAL FOB / Max Input Date columns appear. The rightmost "ACS Match?" column
 * is position:sticky right so the verdict stays visible while the table scrolls.
 *
 * All colour classes (cell-match / cell-miss / cell-empty / cell-c / etc.) come
 * from global.css — this file just decides which class applies per cell.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { CompRow, RowAnnotation } from '../lib/types';
import { verdictOf } from '../lib/comparison';
import { PREFERRED_CURRENCY } from '../lib/constants';

interface Props {
  rows: CompRow[];               // already filtered by App
  hasC: boolean;                 // whether to render Costsheet columns
  // User-filled annotation columns (not DB-sourced), keyed by CompRow.rowKey.
  annotations: Record<string, RowAnnotation>;
  onErrorFromChange: (rowKey: string, value: string) => void;
  onDoneChange: (rowKey: string, done: boolean) => void;
  canEdit: boolean;              // false → the Error From / Done inputs are disabled (read-only user)
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

export default function ResultsTable({
  rows,
  hasC,
  annotations,
  onErrorFromChange,
  onDoneChange,
  canEdit,
}: Props) {
  // How many rows to actually put in the DOM. User-adjustable via the dropdown
  // above the table; deliberately NOT reset on re-validate so the user's choice sticks.
  const [displayLimit, setDisplayLimit] = useState(DEFAULT_ROW_LIMIT);
  const shown = rows.slice(0, displayLimit);

  // ── Resizable columns ─────────────────────────────────────────────────────
  // The table first renders with auto layout; once a data row exists we measure
  // each column's natural width, lock them into a <colgroup> (table-layout:
  // fixed), and let the user drag the right edge of any header cell.
  // +4 leaf columns before the sticky "ACS Match?" verdict: the user-filled
  // "Error From" / "Done" pair, plus "Changed By" / "Changed On" attribution.
  const colCount = hasC ? 23 : 18; // leaf columns, must match the header rows below
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
    used: hasC ? 11 : 10,
    ppsFob: hasC ? 12 : 11,
    acsFob: hasC ? 13 : 12,
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
      <div className="table-wrap">
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
            <th className="hb" rowSpan={2}>MSC_CODE{resizer(1)}</th>
            <th className="hb" rowSpan={2}>RESPONSIBLE_DEVELOPER{resizer(2)}</th>
            <th className="ha" colSpan={5}>🔑 Key Columns</th>
            {/* Size Comparison spans 2 columns by default, 3 when Costsheet is loaded */}
            <th className="hlogic grp" colSpan={hasC ? 3 : 2}>Size Comparison</th>
            <th className="hlogic grp">FOB Source</th>
            <th className="hb grp">PPS FOB</th>
            <th className="ha grp">ACS FOB</th>
            {hasC && (
              <>
                <th className="hc grp">WISDOM FINAL FOB</th>
                <th className="hc" rowSpan={2}>Version{resizer(15)}</th>
                <th className="hc" rowSpan={2}>Cost Sheet No{resizer(16)}</th>
                <th className="hc">Max Input Date</th>
              </>
            )}
            {/* User-filled columns + save attribution, just before the verdict.
                Leaf indices: Error From colCount-5, Done -4, Changed By -3, Changed On -2. */}
            <th className="hrow grp" rowSpan={2}>Error From{resizer(colCount - 5)}</th>
            <th className="hrow" rowSpan={2}>Done{resizer(colCount - 4)}</th>
            <th className="hrow grp" rowSpan={2}>Changed By{resizer(colCount - 3)}</th>
            <th className="hrow" rowSpan={2}>Changed On{resizer(colCount - 2)}</th>
            {/* ACS Match? is sticky-right + spans both header rows */}
            <th className="hrow grp sticky-end" rowSpan={2}>ACS Match?{resizer(colCount - 1)}</th>
          </tr>
          {/* Header row 2 — sub-labels for each grouped column */}
          <tr>
            <th className="ha">Season{resizer(3)}</th>
            <th className="ha">Size{resizer(4)}</th>
            <th className="ha">Style{resizer(5)}</th>
            <th className="ha">Color{resizer(6)}</th>
            <th className="ha">Factory{resizer(7)}</th>
            <th className="hlogic grp">PPS SIZE{resizer(8)}</th>
            <th className="hlogic">ACS CBDID SIZE{resizer(9)}</th>
            {hasC && <th className="hc">WISDOM SIZE{resizer(10)}</th>}
            <th className="hlogic grp">Used{resizer(ci.used)}</th>
            <th className="hb grp">Value{resizer(ci.ppsFob)}</th>
            <th className="ha grp">Value{resizer(ci.acsFob)}</th>
            {hasC && (
              <>
                <th className="hc grp">Value{resizer(14)}</th>
                <th className="hc">Max Date{resizer(17)}</th>
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
            //   • noKeyMatch → warning + join-key diagnostic + list of DB colours
            //   • match      → green ✓ badge
            //   • diff       → red ✗ badge + reason chips (which of the 3 sources disagreed)
            let acsResultNode: React.ReactNode;
            if (isNoKey) {
              // Which side(s) of the data are missing for this PPS row?
              //   • ACS is always missing (that's what "noKeyMatch" means).
              //   • WISDOM is missing only if Costsheet is loaded AND its lookup returned nothing.
              const hasDbColors = !!(row.dbColorsForKey && row.dbColorsForKey.length);
              const wisdomMissing = hasC && !row.cMatched;
              const missingSides: string[] = ['ACS'];
              if (wisdomMissing) missingSides.push('WISDOM');

              // The full diagnostic is folded behind a <details> so the sticky
              // verdict column stays narrow — it used to force ~280px width on
              // every row, hiding data columns on small screens.
              acsResultNode = (
                <>
                  <span style={{ color: 'var(--only)' }}>⚠ No Key Match</span>
                  <details className="nokey-details">
                    <summary>details</summary>
                  <div
                    style={{
                      marginTop: 4,
                      color: 'var(--text)',
                      fontSize: '.65rem',
                      lineHeight: 1.5,
                      whiteSpace: 'normal',
                    }}
                  >
                    {/* Summary — which sides are missing */}
                    <div>
                      <span style={{ color: 'var(--muted)' }}>Missing in: </span>
                      <span style={{ color: 'var(--mismatch)', fontWeight: 600 }}>
                        {missingSides.join(' · ')}
                      </span>
                    </div>

                    {/* Composite key for debugging */}
                    <div style={{ marginTop: 3 }}>
                      <span style={{ color: 'var(--text)' }}>Key: </span>
                      <span style={{ color: 'var(--muted)' }}>{row.joinKeyStr || ''}</span>
                    </div>

                    {/* ACS detail — either lists colors we DO have, or says nothing at all */}
                    <div style={{ marginTop: 3 }}>
                      <span style={{ color: 'var(--a-2)' }}>ACS: </span>
                      {hasDbColors ? (
                        <>
                          has colors{' '}
                          <span style={{ color: 'var(--a-2)' }}>
                            {row.dbColorsForKey!.join(', ')}
                          </span>{' '}
                          for this season+style+factory (this PPS color not found)
                        </>
                      ) : (
                        <span style={{ color: 'var(--mismatch)' }}>
                          no record for this season+style+factory
                        </span>
                      )}
                    </div>

                    {/* WISDOM detail — only meaningful when Costsheet is loaded */}
                    {hasC && (
                      <div style={{ marginTop: 3 }}>
                        <span style={{ color: 'var(--c-2)' }}>WISDOM: </span>
                        {row.cMatched ? (
                          <span style={{ color: 'var(--match)' }}>has record</span>
                        ) : (
                          <span style={{ color: 'var(--mismatch)' }}>no record</span>
                        )}
                      </div>
                    )}
                  </div>
                  </details>
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
              const reasons: string[] = [];
              if (row.lqVsAcs === false)
                reasons.push(`PPS!=ACS${fmtDiff(row.localQuoteVal, row.dbFobValue)}`);
              if (hasC && row.cMatched && row.cMatch === false)
                reasons.push(`PPS!=WISDOM${fmtDiff(row.localQuoteVal, row.cFobValue)}`);
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
                </>
              );
            }

            // Render the actual row. Columns are in the same order as the header rows.
            return (
              <tr key={row.rowIdx}>
                <td className="row-num">{row.rowIdx}</td>
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
                {/* PPS LOCAL_QUOTE_AMOUNT + ACS FOB value (both coloured by the 3-way verdict) */}
                <td className={`grp ${lqCls}`}>
                  {row.localQuoteVal || '—'}
                  {row.currency && row.currency.toUpperCase() !== PREFERRED_CURRENCY && (
                    <span style={{ opacity: 0.6, marginLeft: 4, fontSize: '.85em' }}>
                      {row.currency}
                    </span>
                  )}
                </td>
                <td className={`grp ${dbCls}`}>{row.dbFobValue || '—'}</td>
                {/* Costsheet columns: WISDOM Final FOB + Version + Cost Sheet No + Max Input Date.
                    Only when File C is loaded. If no CS row matched, show em-dashes. */}
                {hasC && (
                  <>
                    {row.cMatched ? (
                      <>
                        <td
                          className={`grp ${
                            isNotCompared
                              ? 'cell-notcompared'
                              : row.cMatch
                                ? 'cell-match'
                                : 'cell-miss'
                          }`}
                        >
                          {row.cFobValue || '—'}
                        </td>
                        <td className="cell-c">{row.cVersionVal || '—'}</td>
                        <td className="cell-c">{row.cCostSheetNo || '—'}</td>
                        <td className="cell-c">{row.cDateStr || '—'}</td>
                      </>
                    ) : (
                      <>
                        <td className="grp cell-empty">—</td>
                        <td className="cell-empty">—</td>
                        <td className="cell-empty">—</td>
                        <td className="cell-empty">—</td>
                      </>
                    )}
                  </>
                )}
                {/* User-filled columns — NOT from any data source. "Error From"
                    is a fixed dropdown; "Done" is a checkbox. Keyed by the stable
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
    </>
  );
}
