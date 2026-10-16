/**
 * File C (Costsheet / WISDOM) slot — button to load dbo.VIEW_COSTSHEET_WISDOM
 * and show a row-count pill. Structurally identical to FileSlotACS; only the
 * endpoint differs.
 *
 * Loading Costsheet is optional. When loaded, validation switches to 3-way mode
 * (all three sources must agree for a row to be a Match).
 */
import { useState } from 'react';
import type { TableData } from '../lib/types';
import { fetchCostsheet } from '../lib/api';
import { useToast } from '../hooks/useToast';
import DbIcon from './DbIcon';

interface Props {
  data: TableData | null;
  onLoad: (data: TableData) => void;
  onClear: () => void;
}

export default function FileSlotCostsheet({ data, onLoad, onClear }: Props) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  const handleLoad = async () => {
    setLoading(true);
    try {
      const d = await fetchCostsheet();
      onLoad(d);
      toast(`Loaded Costsheet from DB (${d.rows.length} rows)`, 'ok');
    } catch (err) {
      toast(`Error: ${(err as Error).message}`, 'err');
    } finally {
      setLoading(false);
    }
  };

  return (
    // Source card: header (icon · label · Optional | ✕), then Load button or "✓ N rows"
    <div className={`source-card sc${data ? ' loaded' : ''}`}>
      <div className="source-card-head">
        <DbIcon />
        <span className="slot-label lc">Costsheet</span>
        {data ? (
          <button className="source-clear" onClick={onClear} title="Clear Costsheet">
            ✕
          </button>
        ) : (
          <span className="source-tag">Optional</span>
        )}
      </div>
      <div className="setup-ctrl">
        {data ? (
          <div className="source-status" title={data.name}>
            <span className="ok">✓</span> <strong>{data.rows.length.toLocaleString()}</strong> rows
            <span className="source-name">{data.name}</span>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={handleLoad} disabled={loading}>
            {loading ? 'Loading…' : 'Load Costsheet'}
          </button>
        )}
      </div>
    </div>
  );
}
