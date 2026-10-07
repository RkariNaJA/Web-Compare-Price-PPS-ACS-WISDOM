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
    <div className="file-slot mid">
      <div className="slot-label lc">Wisdom DB — Costsheet</div>
      {data ? (
        // Loaded state: pill with row count.
        <>
          <div className="file-pill" style={{ justifyContent: 'flex-start' }}>
            <span className="pill-icon">📊</span>
            <span className="pill-name">{data.name}</span>
            <span className="pill-rows">{data.rows.length} rows</span>
            <span className="pill-del" onClick={onClear}>
              ✕
            </span>
          </div>
        </>
      ) : (
        // Empty state: green-tinted button (matches --c colour token).
        <button className="btn btn-primary green" onClick={handleLoad} disabled={loading}>
          {loading ? 'Loading…' : 'Load Costsheet from DB'}
        </button>
      )}
    </div>
  );
}
