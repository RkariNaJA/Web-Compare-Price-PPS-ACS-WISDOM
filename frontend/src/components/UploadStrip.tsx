/**
 * "Set up a validation" — the centred card shown before the first Validate (and
 * again after "Change data"). Laid out as a flow: one card per source (ACS ·
 * Costsheet · PPS) side by side, animated connector lines merging into the
 * "ready" hub that holds the Validate button, then the collapsed "How matching
 * works" reference. On narrow screens the cards stack.
 * After a successful Validate, App swaps this card for the thin DataSummaryBar.
 *
 * This is a pure layout/passthrough component — the source rows handle their own
 * state and API calls. UploadStrip just wires them to App's setters.
 */
import type { Dispatch, SetStateAction } from 'react';
import type { PPSFile, TableData } from '../lib/types';
import FileSlotACS from './FileSlotACS';
import FileSlotPPS from './FileSlotPPS';
import FileSlotCostsheet from './FileSlotCostsheet';
import KeyInfoPanel from './KeyInfoPanel';

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
  onCancel?: () => void;    // set when results exist: go back to them without re-validating
}

export default function UploadStrip(props: Props) {
  return (
    <div className="setup-wrap">
      <section className="setup-card">
        <h2 className="setup-title">Set up a validation</h2>
        <div className="source-grid">
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
        {/* Connectors: one line per source column, merging into the hub below.
            A line animates (flowing dashes) once its source is loaded. The
            viewBox stretches to the card width; strokes stay 2px. */}
        <svg className="flow-lines" viewBox="0 0 300 76" preserveAspectRatio="none" aria-hidden="true">
          <path className={`flow-line fa${props.dataA ? ' on' : ''}`} d="M50 0 C50 46 150 30 150 76" />
          <path className={`flow-line fc${props.dataC ? ' on' : ''}`} d="M150 0 V76" />
          <path className={`flow-line fb${props.dataBFiles.length ? ' on' : ''}`} d="M250 0 C250 46 150 30 150 76" />
        </svg>
        <div className={`flow-hub${props.canValidate ? ' ready' : ''}`}>
          <span className="load-hint">
            {!props.canValidate
              ? 'Load ACS and at least one PPS factory.'
              : props.dataC
                ? 'Ready — 3-way check: PPS · ACS · Costsheet'
                : 'Ready — 2-way check: PPS · ACS'}
          </span>
          {props.onCancel && (
            <button className="btn btn-ghost" onClick={props.onCancel}>
              Back to results
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={props.onValidate}
            disabled={!props.canValidate || props.validating}
            title={props.canValidate ? 'Run the validation' : 'Load ACS and at least one PPS factory'}
          >
            {props.validating ? 'Validating…' : '▶ Validate'}
          </button>
        </div>
        <KeyInfoPanel />
      </section>
    </div>
  );
}
