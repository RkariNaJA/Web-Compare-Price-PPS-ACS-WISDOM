/**
 * RowDetailsModal — the pop-up behind the "details ›" button in the "ACS Match?"
 * cell, for Diff and No Key Match rows.
 *   • Diff:         every source's price, which FOB column it came from, the sizes
 *                   that decided that column, and which source is the odd one out.
 *   • No Key Match: which side(s) are missing, the join key, the colours ACS does
 *                   have for this season+style+factory, and what PPS / WISDOM hold.
 * Display-only: nothing here changes the verdict.
 *
 * Rendered through a portal on <body> so the table's sticky cells and overflow
 * scrolling can't clip it. Closes on ×, Esc, or a click outside.
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CompRow } from '../lib/types';
import { fobEq } from '../lib/comparison';

interface Props {
  row: CompRow;
  hasC: boolean;
  onClose: () => void;
}

// PPS minus the other source, so "+" means PPS is higher. 4 dp hides float noise.
function diffText(pps: string, other: string): string {
  const x = parseFloat(pps);
  const y = parseFloat(other);
  if (isNaN(x) || isNaN(y)) return '—';
  const d = Math.round((x - y) * 10000) / 10000;
  return `${d > 0 ? '+' : ''}${d}`;
}

function Mark({ ok }: { ok: boolean }) {
  return <span className={ok ? 'dd-ok' : 'dd-bad'}>{ok ? '✓ same' : '✗ differs'}</span>;
}

// The WISDOM record the lookup picked — shared by both views.
function WisdomRecord({ row }: { row: CompRow }) {
  return (
    <>
      <h4>WISDOM record used</h4>
      <div className="dd-grid">
        <span className="dd-muted">Cost Sheet No</span>
        <span>{row.cCostSheetNo || '—'}</span>
        <span className="dd-muted">Version</span>
        <span>{row.cVersionVal || '—'}</span>
        <span className="dd-muted">Max Input Date</span>
        <span>{row.cDateStr || '—'}</span>
        <span className="dd-muted">Created CBD by</span>
        <span>{row.cCreatedBy || '—'}</span>
      </div>
    </>
  );
}

// Which WISDOM column a row's size-picked price came from, e.g. "Final FOB (L4L)".
function wisdomColName(row: CompRow): string {
  return `${row.cIsExt ? 'Ext Size FOB' : 'Final FOB'}${row.l4l ? ' (L4L)' : ''}`;
}

function DiffBody({ row, hasC }: { row: CompRow; hasC: boolean }) {
  const wisdomOk = hasC && row.cMatched;
  const ppsAcs = fobEq(row.localQuoteVal, row.dbFobValue);
  const ppsW = wisdomOk && fobEq(row.localQuoteVal, row.cFobValue);
  const acsW = wisdomOk && fobEq(row.dbFobValue, row.cFobValue);

  let cause = 'PPS differs from ACS';
  if (!row.acsCompared) {
    // THB quote with no ACS local columns loaded: only WISDOM's L4L price was checked.
    cause = !wisdomOk
      ? `No WISDOM record to check this ${row.currency} quote against`
      : !row.cFobValue
        ? `WISDOM has no ${row.currency} (L4L) price for this record`
        : `PPS differs from WISDOM ${row.currency} (L4L) price`;
  } else if (wisdomOk) {
    if (acsW && !ppsAcs) cause = 'PPS differs from both ACS and WISDOM';
    else if (ppsAcs && !ppsW) cause = 'WISDOM differs from PPS and ACS';
    else if (ppsW && !ppsAcs) cause = 'ACS differs from PPS and WISDOM';
    else if (!ppsAcs && !ppsW && !acsW) cause = 'All three prices differ';
  } else if (hasC) {
    cause = ppsAcs
      ? 'PPS = ACS, but there is no WISDOM record to confirm it'
      : 'PPS differs from ACS, and there is no WISDOM record';
  }

  const acsCol = row.l4l
    ? row.fobSource === 'FinalFOB'
      ? 'LocalCurrencyFOB'
      : 'LocalExtSzFOB'
    : row.fobSource === 'FinalFOB'
      ? 'Final FOB'
      : 'ExtSzFOB';
  const sizeEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  return (
    <>
      <div className="dd-cause">
        <span className="dd-muted">Likely cause</span>
        <strong>{cause}</strong>
      </div>

      {/* Prices — PPS is the reference the other two are checked against */}
      <h4>FOB prices</h4>
      <table className="dd-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Column used</th>
            <th>FOB</th>
            <th>vs PPS</th>
            <th>PPS − source</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>PPS</td>
            <td>LOCAL_QUOTE_AMOUNT</td>
            <td className="dd-num">
              {row.localQuoteVal || '—'} {row.currency}
            </td>
            <td className="dd-muted">reference</td>
            <td />
          </tr>
          <tr>
            <td>ACS</td>
            <td>{acsCol}</td>
            <td className="dd-num">{row.dbFobValue || '—'}</td>
            {row.acsCompared ? (
              <>
                <td><Mark ok={ppsAcs} /></td>
                <td className="dd-num">{ppsAcs ? '' : diffText(row.localQuoteVal, row.dbFobValue)}</td>
              </>
            ) : (
              <td colSpan={2} className="dd-muted">
                not compared (ACS data has no {row.currency} price columns)
              </td>
            )}
          </tr>
          {hasC && (
            <tr>
              <td>WISDOM</td>
              <td>{wisdomOk ? wisdomColName(row) : '—'}</td>
              <td className="dd-num">
                {wisdomOk ? row.cFobValue || '—' : <span className="dd-bad">no record</span>}
              </td>
              <td>{wisdomOk && <Mark ok={ppsW} />}</td>
              <td className="dd-num">
                {wisdomOk && !ppsW ? diffText(row.localQuoteVal, row.cFobValue) : ''}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Sizes — they decide which FOB column each side priced from */}
      <h4>Sizes</h4>
      <table className="dd-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Size</th>
            <th>vs PPS</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>PPS</td>
            <td>{row.bSize || '—'}</td>
            <td className="dd-muted">reference</td>
          </tr>
          <tr>
            <td>ACS</td>
            <td>{row.dbCbdidSize || '—'}</td>
            <td><Mark ok={sizeEq(row.bSize, row.dbCbdidSize)} /></td>
          </tr>
          {wisdomOk && (
            <tr>
              <td>WISDOM</td>
              <td>{row.cSizeVal || '—'}</td>
              <td><Mark ok={sizeEq(row.bSize, row.cSizeNorm || '')} /></td>
            </tr>
          )}
        </tbody>
      </table>

      {wisdomOk && <WisdomRecord row={row} />}
    </>
  );
}

function NoKeyBody({ row, hasC }: { row: CompRow; hasC: boolean }) {
  const colors = row.dbColorsForKey ?? [];
  const ppsColor = row.keys.find((k) => k.aName === 'ColorwayCode')?.bVal || '—';
  const wisdomOk = hasC && row.cMatched;
  const missing = ['ACS'];
  if (hasC && !row.cMatched) missing.push('WISDOM');

  return (
    <>
      <div className="dd-cause dd-cause-nokey">
        <span className="dd-muted">Missing in</span>
        <strong>{missing.join(' · ')}</strong>
        <span>
          {colors.length
            ? `ACS has this season + style + factory, but not color ${ppsColor}.`
            : 'ACS has no record for this season + style + factory.'}
        </span>
      </div>

      <h4>ACS lookup</h4>
      <div className="dd-grid">
        <span className="dd-muted">Join key</span>
        <span className="dd-mono">{row.joinKeyStr || '—'}</span>
        <span className="dd-muted">PPS color</span>
        <span>{ppsColor}</span>
        <span className="dd-muted">Colors ACS has</span>
        <span>
          {colors.length ? (
            <span className="dd-chips">
              {colors.map((c) => (
                <span key={c} className="dd-key">{c}</span>
              ))}
            </span>
          ) : (
            <span className="dd-bad">none for this season + style + factory</span>
          )}
        </span>
      </div>

      <h4>What the other sources hold</h4>
      <table className="dd-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Size</th>
            <th>FOB</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>PPS</td>
            <td>{row.bSize || '—'}</td>
            <td className="dd-num">
              {row.localQuoteVal || '—'} {row.currency}
            </td>
          </tr>
          {hasC && (
            <tr>
              <td>WISDOM</td>
              {wisdomOk ? (
                <>
                  <td>{row.cSizeVal || '—'}</td>
                  <td className="dd-num">
                    {row.cFobValue || '—'}{' '}
                    <span className="dd-muted">({wisdomColName(row)})</span>
                  </td>
                </>
              ) : (
                <td colSpan={2}><span className="dd-bad">no record</span></td>
              )}
            </tr>
          )}
        </tbody>
      </table>

      {wisdomOk && <WisdomRecord row={row} />}
    </>
  );
}

export default function RowDetailsModal({ row, hasC, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isNoKey = row.status === 'noKeyMatch';
  const title: ReactNode = isNoKey ? (
    <span className="dd-nokey">⚠ No Key Match</span>
  ) : (
    <span className="dd-bad">✗ Diff</span>
  );

  return createPortal(
    <div className="dd-backdrop" onMouseDown={onClose}>
      <div
        className="dd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dd-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dd-head">
          <h3 id="dd-title">
            {title} — row #{row.rowIdx}
          </h3>
          <button className="dd-close" onClick={onClose} aria-label="Close" autoFocus>
            ×
          </button>
        </div>

        {/* Which record this is */}
        <div className="dd-keys">
          {row.keys.map((k) => (
            <span key={k.aName} className="dd-key">
              <span className="dd-muted">{k.aName}</span> {k.bVal || '—'}
            </span>
          ))}
        </div>

        {isNoKey ? <NoKeyBody row={row} hasC={hasC} /> : <DiffBody row={row} hasC={hasC} />}
      </div>
    </div>,
    document.body,
  );
}
