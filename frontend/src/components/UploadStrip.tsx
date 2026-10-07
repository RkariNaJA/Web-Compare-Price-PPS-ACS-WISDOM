/**
 * The "Load data" panel at the top of the app: one row per data source, then
 * the Validate button — load first, validate second, all in one place.
 * Layout: ACS · Costsheet side by side, PPS (factory picker) full width below.
 *
 * This is a pure layout/passthrough component — the source rows handle their own
 * state and API calls. UploadStrip just wires them to App's setters.
 */
import type { Dispatch, SetStateAction } from 'react';
import type { PPSFile, TableData } from '../lib/types';
import FileSlotACS from './FileSlotACS';
import FileSlotPPS from './FileSlotPPS';
import FileSlotCostsheet from './FileSlotCostsheet';

interface Props {
  dataA: TableData | null;
  dataC: TableData | null;
  dataBFiles: PPSFile[];
  setDataA: (d: TableData | null) => void;
  setDataC: (d: TableData | null) => void;
  // Full React setter (Dispatch<SetStateAction>) so FileSlotPPS can use the
  // functional form setFiles(prev => ...) — needed to avoid a stale-closure bug
  // when several factory fetches resolve at once.
  setDataBFiles: Dispatch<SetStateAction<PPSFile[]>>;
  canValidate: boolean;     // ACS + at least one PPS factory loaded
  onValidate: () => void;   // App's Validate handler
  validating: boolean;      // Validate is running (waiting on the Team Mer master) — blocks double clicks
}

export default function UploadStrip(props: Props) {
  return (
    <section className="load-panel">
      <div className="load-title">1 · Load data</div>
      <div className="load-grid">
        <FileSlotACS
          data={props.dataA}
          onLoad={props.setDataA}
          onClear={() => props.setDataA(null)}
        />
        <FileSlotCostsheet
          data={props.dataC}
          onLoad={props.setDataC}
          onClear={() => props.setDataC(null)}
        />
        <FileSlotPPS files={props.dataBFiles} setFiles={props.setDataBFiles} />
      </div>
      <div className="load-foot">
        <span className="load-hint">
          {!props.canValidate
            ? 'Load ACS and at least one PPS factory to validate.'
            : props.dataC
              ? 'Ready — 3-way check: PPS vs ACS vs Costsheet.'
              : 'Ready — Costsheet not loaded, so the check is PPS vs ACS only.'}
        </span>
        <button
          className="btn btn-primary"
          onClick={props.onValidate}
          disabled={!props.canValidate || props.validating}
          title={props.canValidate ? 'Run 3-way validation' : 'Load ACS and at least one PPS factory'}
        >
          {props.validating ? 'Validating…' : '▶ Validate'}
        </button>
      </div>
    </section>
  );
}
