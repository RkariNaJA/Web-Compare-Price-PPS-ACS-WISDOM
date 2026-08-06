/**
 * Validation Summary view (public to all logged-in users; reached from the header
 * switcher). Summarizes the CURRENT validation into ONE Match / Diff / No Key **donut
 * per factory** (small multiples — factories are shown separately, never lumped
 * together), plus a Factory × Season **breakdown table** with the exact numbers. Pure
 * presentation over lib/summary.ts; styling follows the washi/sumi design system.
 */
import { useMemo } from 'react';
import type { CompRow } from '../lib/types';
import { summarize, type GroupCount } from '../lib/summary';

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

// Conic-gradient donut for one group's Match → Diff → No Key → Not Compared split
// (fixed order). Every stop's END is derived from that slice's OWN count — none of
// the four is ever "whatever's left" (that implicit-remainder shape is exactly what
// used to paint notCompared rows in the No Key colour).
const donutStyle = (g: GroupCount) => {
  const t = g.total || 1;
  const mEnd = (g.match / t) * 100;
  const dEnd = ((g.match + g.diff) / t) * 100;
  const nkEnd = ((g.match + g.diff + g.noKey) / t) * 100;
  const ncEnd = ((g.match + g.diff + g.noKey + g.notCompared) / t) * 100;
  return {
    background: `conic-gradient(var(--match) 0 ${mEnd}%, var(--mismatch) ${mEnd}% ${dEnd}%, var(--only) ${dEnd}% ${nkEnd}%, var(--notcompared) ${nkEnd}% ${ncEnd}%)`,
  };
};

function FactoryDonut({ g }: { g: GroupCount }) {
  return (
    <div className="summary-factory-card">
      <h3 className="summary-factory-name" title={g.key}>
        {g.key}
      </h3>
      <div className="summary-donut-wrap">
        <div
          className="summary-donut"
          style={donutStyle(g)}
          role="img"
          aria-label={`${g.key}: Match ${g.match} (${pct(g.match, g.total)}%), Diff ${g.diff} (${pct(
            g.diff,
            g.total,
          )}%), No Key ${g.noKey} (${pct(g.noKey, g.total)}%), Not Compared ${g.notCompared} (${pct(
            g.notCompared,
            g.total,
          )}%)`}
        />
        <div className="summary-donut-center">
          <span className="dc-total">{g.total}</span>
          <span className="dc-label">rows</span>
        </div>
      </div>
      <ul className="summary-legend-list">
        <li>
          <span className="dot" style={{ background: 'var(--match)' }} />
          <span className="ll-label">Match</span>
          <span className="ll-count">{g.match}</span>
          <span className="ll-pct">{pct(g.match, g.total)}%</span>
        </li>
        <li>
          <span className="dot" style={{ background: 'var(--mismatch)' }} />
          <span className="ll-label">Diff</span>
          <span className="ll-count">{g.diff}</span>
          <span className="ll-pct">{pct(g.diff, g.total)}%</span>
        </li>
        <li>
          <span className="dot" style={{ background: 'var(--only)' }} />
          <span className="ll-label">No Key</span>
          <span className="ll-count">{g.noKey}</span>
          <span className="ll-pct">{pct(g.noKey, g.total)}%</span>
        </li>
        <li>
          <span className="dot" style={{ background: 'var(--notcompared)' }} />
          <span className="ll-label">Not Compared</span>
          <span className="ll-count">{g.notCompared}</span>
          <span className="ll-pct">{pct(g.notCompared, g.total)}%</span>
        </li>
      </ul>
    </div>
  );
}

export default function SummaryDashboard({ rows }: { rows: CompRow[] }) {
  const s = useMemo(() => summarize(rows), [rows]);

  if (rows.length === 0) {
    return (
      <div className="summary-empty">
        <div style={{ fontSize: 44, opacity: 0.25 }}>◔</div>
        <h3 style={{ color: 'var(--text)', fontWeight: 500 }}>No validation yet</h3>
        <p>
          Run a validation in <strong>Compare Data</strong>, then come back here for the summary.
        </p>
      </div>
    );
  }

  const { match, diff, noKey, notCompared, total } = s.totals;

  return (
    <div className="summary-dashboard">
      <div className="summary-inner">
        {/* One donut per factory — shown separately, never combined */}
        <div className="summary-donut-grid">
          {s.byFactory.map((f) => (
            <FactoryDonut key={f.key} g={f} />
          ))}
        </div>

        {/* Factory × Season breakdown (exact numbers, + overall Totals row) */}
        <section className="summary-card">
          <h2>Factory × Season breakdown</h2>
          <div className="log-table-wrap">
            <table className="log-table">
              <thead>
                <tr>
                  <th>Factory</th>
                  <th>Season</th>
                  <th>Match</th>
                  <th>Diff</th>
                  <th>No Key</th>
                  <th>Not Compared</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {s.byFactorySeason.map((r) => (
                  <tr key={`${r.factory}|${r.season}`}>
                    <td>{r.factory}</td>
                    <td>{r.season}</td>
                    <td className="summary-num match">{r.match}</td>
                    <td className="summary-num diff">{r.diff}</td>
                    <td className="summary-num nokey">{r.noKey}</td>
                    <td className="summary-num notcompared">{r.notCompared}</td>
                    <td className="summary-num">{r.total}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td />
                  <td className="summary-num match">
                    <strong>{match}</strong>
                  </td>
                  <td className="summary-num diff">
                    <strong>{diff}</strong>
                  </td>
                  <td className="summary-num nokey">
                    <strong>{noKey}</strong>
                  </td>
                  <td className="summary-num notcompared">
                    <strong>{notCompared}</strong>
                  </td>
                  <td className="summary-num">
                    <strong>{total}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
