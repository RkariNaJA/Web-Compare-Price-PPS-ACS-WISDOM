/**
 * File C (Costsheet / WISDOM) slot — button to load dbo.VIEW_COSTSHEET_WISDOM
 * plus a compact preview. Structurally identical to FileSlotACS; the difference
 * is which endpoint it hits and the alias-tolerant column resolution for the preview.
 *
 * Loading Costsheet is optional. When loaded, validation switches to 3-way mode
 * (all three sources must agree for a row to be a Match).
 */
import { useState } from 'react';
import type { TableData } from '../lib/types';
import { fetchCostsheet } from '../lib/api';
import { useToast } from '../hooks/useToast';
import { C_KEY_MAP } from '../lib/constants';
import { findCostsheetIdx } from '../lib/normalize';
import PreviewTable from './PreviewTable';

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

  // Resolve preview columns via alias-tolerant matcher. If the view uses
  // "FinalFOB" or "Final_FOB" instead of "Final FOB", it still finds it.
  // The header LABEL displayed uses whatever the view actually returned, so the
  // user sees the real column name (not the idealised one from C_KEY_MAP).
  const previewIdxs = data
    ? (
        [
          { name: C_KEY_MAP.season, key: 'season' as const },
          { name: C_KEY_MAP.style, key: 'style' as const },
          { name: C_KEY_MAP.color, key: 'color' as const },
          { name: C_KEY_MAP.factory, key: 'factory' as const },
          { name: C_KEY_MAP.size, key: 'size' as const },
          { name: C_KEY_MAP.fob, key: 'fob' as const },
          { name: C_KEY_MAP.date, key: 'date' as const },
        ]
          .map((d2) => ({
            name: data.headers[findCostsheetIdx(data.headers, d2.key)] ?? d2.name,
            idx: findCostsheetIdx(data.headers, d2.key),
          }))
          .filter((c) => c.idx !== -1)  // silently drop columns the view didn't return
      )
    : [];

  return (
    <div className="file-slot mid">
      <div className="slot-label lc">Wisdom DB — Costsheet</div>
      {data ? (
        // Loaded state: pill + mini preview.
        <>
          <div className="file-pill" style={{ justifyContent: 'flex-start' }}>
            <span className="pill-icon">📊</span>
            <span className="pill-name">{data.name}</span>
            <span className="pill-rows">{data.rows.length} rows</span>
            <span className="pill-del" onClick={onClear}>
              ✕
            </span>
          </div>
          <div className="preview-title">
            <span>Preview</span>
            <span>{data.rows.length} rows</span>
          </div>
          <PreviewTable
            headers={previewIdxs.map((c) => c.name)}
            rows={data.rows.slice(0, 5).map((r) => previewIdxs.map((c) => r[c.idx] ?? ''))}
          />
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
