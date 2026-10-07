/**
 * File A (ACS) slot — one button that fetches dbo.ACS from the Flask backend.
 * After loading, shows a pill with the row count (✕ clears it).
 */
import { useState } from 'react';
import type { TableData } from '../lib/types';
import { fetchACS } from '../lib/api';
import { useToast } from '../hooks/useToast';

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
    <div className="source-row">
      <div className="slot-label la">ACS</div>
      {data ? (
        // Loaded state: pill with row count — sits where the Load button was.
        <div className="file-pill">
          <span className="pill-icon">🗄️</span>
          <span className="pill-name">{data.name}</span>
          <span className="pill-rows">{data.rows.length.toLocaleString()} rows</span>
          <span className="pill-del" onClick={onClear} title="Clear ACS">
            ✕
          </span>
        </div>
      ) : (
        <button className="btn btn-primary" onClick={handleLoad} disabled={loading}>
          {loading ? 'Loading…' : 'Load ACS from DB'}
        </button>
      )}
    </div>
  );
}
