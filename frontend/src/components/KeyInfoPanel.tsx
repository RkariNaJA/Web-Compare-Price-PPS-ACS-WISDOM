/**
 * "How matching works" — a collapsed-by-default reference panel between the
 * Load data panel and the results.
 *
 * Shows the 5 join-key pairs as chips and a step-by-step explanation of the FOB
 * selection logic (both ACS and Costsheet). Static: nothing here changes what
 * the comparison does. (The Validate button lives in UploadStrip.)
 */
import { KEY_PAIRS } from '../lib/constants';

interface Props {
  visible: boolean;         // whether ACS + at least one PPS are loaded
}

export default function KeyInfoPanel({ visible }: Props) {
  if (!visible) return null;
  return (
    // Native <details>: collapsed by default, opens with one click, no state needed.
    <details className="key-panel">
      <summary>ⓘ How matching works — fixed keys &amp; FOB logic</summary>

      {/* Chips showing the ACS ⇄ PPS column mapping (driven from KEY_PAIRS) */}
      <div className="key-grid">
        {KEY_PAIRS.map((kp) => (
          <div className="key-chip" key={kp.a}>
            <span className="side-a">{kp.a}</span>
            <span className="arrow">⇄</span>
            <span className="side-b">{kp.b}</span>
          </div>
        ))}
        {/* De-dup key field — display only. Deliberately NOT added to KEY_PAIRS
            (that array drives the join + results columns); this chip just shows
            that LOCAL_QUOTE_AMOUNT is part of the PPS de-duplication key, so
            different quotes stay as separate rows. */}
        <div
          className="key-chip"
          title="Part of the PPS de-duplication key — different quotes stay as separate rows"
        >
          <span className="side-c">De-dup key</span>
          <span className="arrow">+</span>
          <span className="side-b">LOCAL_QUOTE_AMOUNT</span>
        </div>
      </div>

      {/* Static logic reference — matches the code paths in comparison.ts and costsheet.ts */}
      <div className="logic-box">
        <strong style={{ color: 'var(--text)' }}>FOB Selection Logic (ACS DB):</strong>
        <br />
        1. Match on Season + Style + Color + Factory (color falls back to ALL_SOLID).
        <br />
        2. Pick the ACS row whose CBDID size matches PPS <code>SIZE_DATA</code> (converted).
        <br />
        3. If sizes match → compare <code>LOCAL_QUOTE_AMOUNT</code> vs{' '}
        <span className="hl-match">Final FOB</span> · else vs{' '}
        <span className="hl-ext">ExtSzFOB</span>.
        <br />
        <strong style={{ color: 'var(--text)' }}>WISDOM DB (Costsheet) Logic:</strong>
        <br />
        4. Match on same 5 keys · if multiple records → pick{' '}
        <span className="hl-c">MAX(First Input Date)</span> · compare{' '}
        <code>LOCAL_QUOTE_AMOUNT</code> vs <span className="hl-c">Costsheet Final FOB</span>.
        <br />
        <strong style={{ color: 'var(--text)' }}>PPS DB Logic:</strong>
        <br />
        5. Convet Size into {' '}
        <span className="hl-match">ALL_REG_SIZE_RB</span> · or{' '}
        <span className="hl-ext">ALL_EXTEND_SIZE_RB</span>.
        <br />
        6. De-duplicate quote history — keep one row per{' '}
        <span className="hl-c">Season + Style + Color + Size + <code>LOCAL_QUOTE_AMOUNT</code></span>{' '}
        (newest by <code>INSERT_DATE</code>). Uses the <strong>real</strong> size, not the converted
        bucket, so every size is kept · different quotes stay as separate rows.
      </div>
    </details>
  );
}
