/**
 * The 3-column strip at the top of the app where the user loads all three data sources.
 * Layout: ACS (left) · Costsheet (middle) · PPS (right), separated by "&" and "VS".
 *
 * This is a pure layout/passthrough component — the actual file slots handle their own
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
  // when several FileReader callbacks race after a multi-file drop.
  setDataBFiles: Dispatch<SetStateAction<PPSFile[]>>;
}

export default function UploadStrip(props: Props) {
  return (
    <div className="upload-strip">
      <FileSlotACS
        data={props.dataA}
        onLoad={props.setDataA}
        onClear={() => props.setDataA(null)}
      />
      <div className="vs">&amp;</div>
      <FileSlotCostsheet
        data={props.dataC}
        onLoad={props.setDataC}
        onClear={() => props.setDataC(null)}
      />
      <div className="vs">VS</div>
      <FileSlotPPS files={props.dataBFiles} setFiles={props.setDataBFiles} />
    </div>
  );
}
