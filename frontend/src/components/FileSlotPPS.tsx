/**
 * File B (PPS) slot — loads PPS data from the dbo.PPS table instead of file uploads.
 *
 * On mount it fetches the distinct FTYCODE list from the backend; the user ticks
 * the factories they want and clicks Load. Each factory becomes one PPSFile entry
 * (own pill colour, removable) so everything downstream — comparison, results
 * table, CSV export — behaves exactly as it did with uploaded files.
 *
 * Rows arrive raw from SQL (all columns, no dedupe); this component projects them
 * down to STRICT_B_COLS and normalises SIZE_DATA (keeping ORIG_SIZE_DATA), the
 * same transformation the old file reader applied.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { PPSFile, Row, TableData } from '../lib/types';
import { FILE_COLORS, MAX_B_FILES, STRICT_B_COLS } from '../lib/constants';
import { fetchPPS, fetchPPSFactories } from '../lib/api';
import { normalizeSizeToken } from '../lib/normalize';
import { useToast } from '../hooks/useToast';

interface Props {
  files: PPSFile[];
  // Full React setter — functional form keeps parallel fetch callbacks from
  // clobbering each other when several factories finish loading at once.
  setFiles: Dispatch<SetStateAction<PPSFile[]>>;
}

// Project a raw dbo.PPS payload down to STRICT_B_COLS and normalise SIZE_DATA,
// mirroring what the old FileReader/XLSX path did to uploaded files.
//Drop Column not in STRICT_B_COLS
function toPPSRows(data: TableData): { headers: string[]; rows: Row[] } {// Function takes a table (data) and returns a new one with headers + rows
  const keptIdx: number[] = []; //Empty list that hold Position
  const keptHdr: string[] = []; //Empty list that hold Name
  data.headers.forEach((h, i) => { 
    if (STRICT_B_COLS.includes(h)) {//Check if column were in the keep list?
      keptIdx.push(i);// Yes same position
      keptHdr.push(h);// Yes same name
      //else ignored or dropped
    }
  });
  const headers = [...keptHdr];
  const rows = data.rows.map((r) => keptIdx.map((i) => r[i] ?? ''));

  // Preserve the raw SIZE_DATA in a shadow column ORIG_SIZE_DATA before
  // normalising, so the display can still show "S" while the
  // comparison uses "ALL_REG_SIZE_RB".
  // Will get 2 column (SIZE_DATA [data after drop some column], ORIG_SIZE_DATA[Original Column])
  const sizeIdx = headers.indexOf('SIZE_DATA');
  if (sizeIdx !== -1) { // Only run the next part IF SIZE_DATA actually exists
    headers.push('ORIG_SIZE_DATA'); // add new column at the backup copy
    rows.forEach((r) => {
      const orig = String(r[sizeIdx] ?? '').trim(); // Grab the current SIZE_DATA value, force it to text, trim spaces
      r.push(orig); // Add that original value as the new ORIG_SIZE_DATA cell (the backup)
      r[sizeIdx] = normalizeSizeToken(orig); // Overwrite the original SIZE_DATA cell with its cleaned-up version
    });
  }
  return { headers, rows };
}

export default function FileSlotPPS({ files, setFiles }: Props) {
  const toast = useToast();
  const [factories, setFactories] = useState<string[]>([]);   // FTYCODE list from the DB
  const [factoriesError, setFactoriesError] = useState(false); // show Retry if the list fetch failed
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  // Fetch the factory list once on mount (Retry re-runs it on failure).
  const loadFactories = () => {
    setFactoriesError(false);
    fetchPPSFactories()
      .then(setFactories)
      .catch((err) => {
        setFactoriesError(true);
        toast(`Error loading factory list: ${(err as Error).message}`, 'err');
      });
  };
  useEffect(loadFactories, []);

  const toggleFactory = (fty: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fty)) next.delete(fty);
      else next.add(fty);
      return next;
    });
  };

  // Load every ticked factory that isn't already loaded. Each one commits via
  // the functional setter as its fetch resolves.
  const handleLoad = async () => {
    const already = new Set(files.map((f) => f.name));
    const toLoad = factories.filter((f) => selected.has(f) && !already.has(f));
    if (!toLoad.length) {
      toast('Select at least one factory to load', 'err');
      return;
    }
    setLoading(true);
    await Promise.all(
      toLoad.map(async (fty) => {
        try {
          const data = await fetchPPS(fty);
          const { headers, rows } = toPPSRows(data);
          setFiles((prev) => {
            if (prev.find((f) => f.name === fty)) return prev; // dedupe on late arrival
            if (prev.length >= MAX_B_FILES) return prev;       // enforce cap
            return [...prev, { name: fty, headers, rows, colorIdx: prev.length }];
          });
          toast(`Loaded PPS ${fty} from DB (${rows.length} rows)`, 'ok');
        } catch (err) {
          toast(`Error loading PPS ${fty}: ${(err as Error).message}`, 'err');
        }
      }),
    );
    setLoading(false);
  };

  // Remove one factory from state and re-index colorIdx so remaining entries
  // still receive contiguous badge colours.
  const remove = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx).map((f, i) => ({ ...f, colorIdx: i })));
  };

  const loadedNames = new Set(files.map((f) => f.name));
  const pendingCount = factories.filter((f) => selected.has(f) && !loadedNames.has(f)).length;

  return (
    // Full-width row: label · factory checkboxes · Load · one pill per loaded factory.
    <div className="source-row pps">
      <div className="slot-label lb">PPS</div>
      {factoriesError ? (
        <button className="btn btn-ghost" onClick={loadFactories}>
          ⟳ Retry loading factory list
        </button>
      ) : !factories.length ? (
        <span className="load-hint">Loading factory list…</span>
      ) : (
        <>
          <div className="factory-picks">
            {factories.map((fty) => {
              const loaded = loadedNames.has(fty);
              return (
                <label key={fty} className={`factory-pick${loaded ? ' loaded' : ''}`}>
                  <input
                    type="checkbox"
                    checked={loaded || selected.has(fty)}
                    disabled={loaded || loading}
                    onChange={() => toggleFactory(fty)}
                  />
                  {fty}
                </label>
              );
            })}
          </div>
          <button
            className="btn btn-primary"
            onClick={handleLoad}
            disabled={loading || pendingCount === 0}
          >
            {loading ? 'Loading…' : 'Load PPS from DB'}
          </button>
        </>
      )}
      {files.length > 0 && (
        <div className="file-pills">
          {files.map((f, i) => {
            const c = FILE_COLORS[f.colorIdx];
            return (
              <div key={f.name} className="file-pill">
                <span className="pill-color" style={{ background: c.hex }} />
                <span className="pill-name" title={f.name}>
                  {f.name}
                </span>
                <span className="pill-rows">{f.rows.length.toLocaleString()} rows</span>
                <span className="pill-del" onClick={() => remove(i)} title={`Clear ${f.name}`}>
                  ✕
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
