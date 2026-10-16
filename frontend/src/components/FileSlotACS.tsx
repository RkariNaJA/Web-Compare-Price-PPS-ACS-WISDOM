/**
 * File A (ACS) slot — one button that fetches dbo.ACS from the Flask backend.
 * After loading, shows a pill with the row count (✕ clears it).
 */
import { useState } from 'react';
import type { TableData } from '../lib/types';
import { fetchACS } from '../lib/api';
import { useToast } from '../hooks/useToast';
import DbIcon from './DbIcon';

interface Props {
  data: TableData | null;              // null until the user clicks the load button
  onLoad: (data: TableData) => void;   // App writes it into its dataA state
  onClear: () => void;                 // App resets dataA to null
}

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

  return (
    // Source card: header (icon · label · Required | ✕), then Load button or "✓ N rows"
    <div className={`source-card sa${data ? ' loaded' : ''}`}>
      <div className="source-card-head">
        <DbIcon />
        <span className="slot-label la">ACS</span>
        {data ? (
          <button className="source-clear" onClick={onClear} title="Clear ACS">
            ✕
          </button>
        ) : (
          <span className="source-tag">Required</span>
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
            {loading ? 'Loading…' : 'Load ACS'}
          </button>
        )}
      </div>
    </div>
  );
}
