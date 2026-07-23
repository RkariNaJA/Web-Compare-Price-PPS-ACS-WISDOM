/**
 * File A (ACS) slot — one button that fetches dbo.ACS from the Flask backend.
 * After loading, shows a compact preview with just the key columns so the user
 * can eyeball the shape before running Validate.
 */
import { useState } from 'react';
import type { TableData } from '../lib/types';
import { fetchACS } from '../lib/api';
import { useToast } from '../hooks/useToast';
import PreviewTable from './PreviewTable';

interface Props {
  data: TableData | null;              // null until the user clicks the load button
  onLoad: (data: TableData) => void;   // App writes it into its dataA state
  onClear: () => void;                 // App resets dataA to null
}

// Which ACS columns to show in the mini preview. Kept short so the strip stays compact.
const PREVIEW_COLS = [
  'Season',
  'StyleNumber',
  'ColorwayCode',
  'FactoryCode',
  'EXTRACTED_SIZE',
  'FinalFOB',
  'ExtSzFOB',
];

export default function FileSlotACS({ data, onLoad, onClear }: Props) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);  // disables the button + shows "Loading…"

  // Click handler: hit the backend, surface success/failure via toast.
  const handleLoad = async () => {
    setLoading(true);
    try {
      const d = await fetchACS();
      onLoad(d);
      toast(`Loaded ACS from DB (${d.rows.length} rows)`, 'ok');
    } catch (err) {
      toast(`Error: ${(err as Error).message}`, 'err');
    } finally {
      setLoading(false);
    }
  };

  // Resolve preview column indexes once per render. Any missing column is silently dropped.
  const previewIdxs = data
    ? PREVIEW_COLS.map((c) => ({ name: c, idx: data.headers.indexOf(c) })).filter((c) => c.idx !== -1)
    : [];

  return (
    <div className="file-slot left">
      <div className="slot-label la">ACS DB — ACS</div>
      {data ? (
        // Loaded state: pill with row count + a small preview table.
        <>
          <div className="file-pill" style={{ justifyContent: 'flex-start' }}>
            <span className="pill-icon">🗄️</span>
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
        // Empty state: single "Load ACS from DB" button.
        <button className="btn btn-primary" onClick={handleLoad} disabled={loading}>
          {loading ? 'Loading…' : 'Load ACS from DB'}
        </button>
      )}
    </div>
  );
}
