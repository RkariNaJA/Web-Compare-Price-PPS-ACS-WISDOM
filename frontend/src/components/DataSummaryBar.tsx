/**
 * Result cards above the results table — one per data source — plus "Change
 * data" (reopens the setup card) and "Re-validate" (re-runs with the data
 * currently loaded).
 *
 * Row counts in the DB come from a snapshot taken at Validate, so editing the
 * data afterwards can't make the cards lie; the per-source results come from
 * sourceStats() over all compared rows (not the filtered view).
 */
import { FILE_COLORS } from '../lib/constants';
import type { SourceResult, SourceStats } from '../lib/sourceStats';

export interface DataSnapshot {
  acsRows: number;
  csRows: number | null;   // null = Costsheet was not loaded for this run
  pps: { name: string; rows: number; colorIdx: number }[];
}

interface Props {
  snapshot: DataSnapshot;
  stats: SourceStats;
  onChange: () => void;      // open the setup card again
  onRevalidate: () => void;  // App's Validate handler
  validating: boolean;
}

const pct = (n: number, d: number) => (d ? Math.round((n * 100) / d) : 0);

// ACS / Costsheet card: coverage of the PPS rows, plus how often the FOB agreed.
function SourceCard(props: {
  label: string;
  tone: 'a' | 'c';
  dbRows: number;
  result: SourceResult;
  total: number;
}) {
  const { label, tone, dbRows, result, total } = props;
  const found = pct(result.found, total);
  return (
    <div className={`result-card s${tone}`}>
      <div className="rc-head">
        <span className={`slot-label l${tone}`}>{label}</span>
        <span className="rc-db">{dbRows.toLocaleString()} rows in DB</span>
      </div>
      <div className="rc-main" title={`PPS rows that found a matching ${label} row`}>
        Found for <strong>{result.found.toLocaleString()}</strong> of {total.toLocaleString()}
        <span className="rc-pct">{found}%</span>
      </div>
      <div className="rc-meter">
        <span style={{ width: `${found}%` }} />
      </div>
      <div className="rc-sub" title="Rows in a non-compared currency are left out">
        FOB agrees {result.agree.toLocaleString()} / {result.compared.toLocaleString()}
      </div>
    </div>
  );
}

export default function DataSummaryBar({ snapshot, stats, onChange, onRevalidate, validating }: Props) {
  return (
    <div className="result-cards">
      <div className="result-card sb">
        <div className="rc-head">
          <span className="slot-label lb">PPS</span>
        </div>
        <div className="rc-main">
          <strong>{stats.total.toLocaleString()}</strong> rows compared
        </div>
        <div className="rc-sub rc-factories">
          {stats.pps.map((f) => (
            <span key={f.name} className="rc-factory">
              <span className="pill-color" style={{ background: FILE_COLORS[f.colorIdx].hex }} />
              {f.name} {f.rows.toLocaleString()}
            </span>
          ))}
        </div>
      </div>

      <SourceCard label="ACS" tone="a" dbRows={snapshot.acsRows} result={stats.acs} total={stats.total} />

      {snapshot.csRows !== null ? (
        <SourceCard
          label="Costsheet"
          tone="c"
          dbRows={snapshot.csRows}
          result={stats.cs}
          total={stats.total}
        />
      ) : (
        <div className="result-card sc rc-off">
          <div className="rc-head">
            <span className="slot-label lc">Costsheet</span>
          </div>
          <div className="rc-main">Not loaded</div>
          <div className="rc-sub">This run was PPS vs ACS only</div>
        </div>
      )}

      <div className="rc-actions">
        <button className="btn btn-primary" onClick={onRevalidate} disabled={validating}>
          {validating ? 'Validating…' : '↻ Re-validate'}
        </button>
        <button className="btn btn-ghost" onClick={onChange}>
          Change data
        </button>
      </div>
    </div>
  );
}
