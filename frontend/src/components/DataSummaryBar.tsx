/**
 * The thin bar above the results once a validation has run. It names the data
 * the CURRENT results were built from (a snapshot taken at Validate, so editing
 * the data afterwards can't make it lie), plus "Change data" — reopens the setup
 * card — and "Re-validate", which re-runs with the data currently loaded.
 */
import { FILE_COLORS } from '../lib/constants';

export interface DataSnapshot {
  acsRows: number;
  csRows: number | null;   // null = Costsheet was not loaded for this run
  pps: { name: string; rows: number; colorIdx: number }[];
}

interface Props {
  snapshot: DataSnapshot;
  onChange: () => void;      // open the setup card again
  onRevalidate: () => void;  // App's Validate handler
  validating: boolean;
}

export default function DataSummaryBar({ snapshot, onChange, onRevalidate, validating }: Props) {
  return (
    <div className="data-summary">
      <span className="ds-label">Data</span>
      <span className="ds-item">
        <span className="slot-label la">ACS</span> {snapshot.acsRows.toLocaleString()} rows
      </span>
      {snapshot.csRows !== null && (
        <span className="ds-item">
          <span className="slot-label lc">Costsheet</span> {snapshot.csRows.toLocaleString()} rows
        </span>
      )}
      <span className="ds-item">
        <span className="slot-label lb">PPS</span>
        {snapshot.pps.map((f) => (
          <span key={f.name} className="ds-factory" title={`${f.rows.toLocaleString()} rows`}>
            <span className="pill-color" style={{ background: FILE_COLORS[f.colorIdx].hex }} />
            {f.name}
          </span>
        ))}
      </span>
      <div className="ds-actions">
        <button className="btn btn-ghost" onClick={onChange}>
          Change data
        </button>
        <button className="btn btn-primary" onClick={onRevalidate} disabled={validating}>
          {validating ? 'Validating…' : '↻ Re-validate'}
        </button>
      </div>
    </div>
  );
}
