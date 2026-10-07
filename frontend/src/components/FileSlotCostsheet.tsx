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
    // Setup-card row: label · (Load button | "✓ N rows") · ✕
    <div className="setup-row">
      <span className="slot-label lc">Costsheet</span>
      <div className="setup-ctrl">
        {data ? (
          <div className="source-status" title={data.name}>
            <span className="ok">✓</span> <strong>{data.rows.length.toLocaleString()}</strong> rows
            <span className="source-name">{data.name}</span>
          </div>
        ) : (
          // Green-tinted button (matches --c colour token).
          <button className="btn btn-primary green" onClick={handleLoad} disabled={loading}>
            {loading ? 'Loading…' : 'Load Costsheet'}
          </button>
        )}
      </div>
      {data ? (
        <button className="source-clear" onClick={onClear} title="Clear Costsheet">
          ✕
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
