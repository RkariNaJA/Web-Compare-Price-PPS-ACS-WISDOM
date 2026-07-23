/**
 * Small, generic preview table used by all three FileSlot components.
 *
 * Renders the first `maxRows` rows (default 5) with a sticky header. Optionally
 * shows a per-row coloured dot when both colorIndices and rowColors are provided
 * (used by the PPS slot to identify which file each row came from).
 */
import type { Row } from '../lib/types';

interface Props {
  headers: string[];
  rows: Row[];
  colorIndices?: number[];               // parallel to rows — colorIndices[i] is rows[i]'s color
  rowColors?: { hex: string }[];         // palette to index into
  maxRows?: number;                      // cap on rendered rows (default 5)
}

export default function PreviewTable({
  headers,
  rows,
  colorIndices,
  rowColors,
  maxRows = 5,
}: Props) {
  const display = rows.slice(0, maxRows);
  // Only render the leading "File" colour column when both companion props are provided.
  const showColor = colorIndices && rowColors;
  return (
    <div className="preview-container active">
      <table className="preview-table">
        <thead>
          <tr>
            {showColor && <th>File</th>}
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.map((row, i) => {
            const color = showColor ? rowColors![colorIndices![i]] : null;
            return (
              <tr key={i}>
                {showColor && (
                  // Coloured dot cell — visually links the row to its source PPS file.
                  <td>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: color!.hex,
                      }}
                    />
                  </td>
                )}
                {row.map((v, j) => (
                  <td key={j}>{String(v ?? '')}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
