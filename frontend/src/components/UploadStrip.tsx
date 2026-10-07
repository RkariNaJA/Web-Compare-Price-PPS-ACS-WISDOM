/**
 * The "Load data" bar at the top of the app: one card per data source, then
 * the Validate column — load first, validate second, all on one row.
 * Layout: ACS · Costsheet · PPS cards (equal height) · Validate. Stacks on narrow screens.
 *
 * This is a pure layout/passthrough component — the source cards handle their own
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
      <div className="validate-col">
        <button
          className="btn btn-primary"
          onClick={props.onValidate}
          disabled={!props.canValidate || props.validating}
          title={props.canValidate ? 'Run the validation' : 'Load ACS and at least one PPS factory'}
        >
          {props.validating ? 'Validating…' : '▶ Validate'}
        </button>
        <span className="load-hint">
          {!props.canValidate
            ? 'Needs ACS + a PPS factory'
            : props.dataC
              ? '3-way: PPS · ACS · Costsheet'
              : '2-way: PPS · ACS'}
        </span>
      </div>
    </section>
  );
}
