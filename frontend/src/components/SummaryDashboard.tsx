/**
 * Validation Summary view (public to all logged-in users; reached from the header
 * switcher). Summarizes the CURRENT validation into ONE Match / Diff / No Key **donut
 * per factory** (small multiples — factories are shown separately, never lumped
 * together) — click a donut to drop down that factory's per-season numbers — plus a
 * **Factory totals** table with the exact numbers (one row per factory). Pure
 * presentation over lib/summary.ts; styling follows the corporate orange/white design system (tokens.css).
 */
import { useMemo, useState } from 'react';
import type { CompRow } from '../lib/types';
import { summarize, type FactorySeasonRow, type GroupCount } from '../lib/summary';

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

// Clickable: selecting a card opens that factory's season breakdown under the grid.
// A <div role="button"> rather than <button>, since the card holds an <h3> and a <ul>.
function FactoryDonut({
  g,
  selected,
  onSelect,
}: {
  g: GroupCount;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`summary-factory-card clickable${selected ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={selected ? `Hide ${g.key} by season` : `Show ${g.key} by season`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
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

// Drop-down under the donut grid: the selected factory's numbers per season + its total.
function FactoryDetail({
  g,
  seasons,
  onClose,
}: {
  g: GroupCount;
  seasons: FactorySeasonRow[];
  onClose: () => void;
}) {
  return (
    <section className="summary-card summary-detail">
      <div className="summary-detail-head">
        <h2>
          ▼ {g.key} — by season
        </h2>
        <button className="source-clear" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="log-table-wrap">
        <table className="log-table">
          <thead>
            <tr>
              <th>Season</th>
              <th>Match</th>
              <th>Diff</th>
              <th>No Key</th>
              <th>Not Compared</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {seasons.map((r) => (
              <tr key={r.season}>
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
              <td className="summary-num match">
                <strong>{g.match}</strong>
              </td>
              <td className="summary-num diff">
                <strong>{g.diff}</strong>
              </td>
              <td className="summary-num nokey">
                <strong>{g.noKey}</strong>
              </td>
              <td className="summary-num notcompared">
                <strong>{g.notCompared}</strong>
              </td>
              <td className="summary-num">
                <strong>{g.total}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function SummaryDashboard({ rows }: { rows: CompRow[] }) {
  const s = useMemo(() => summarize(rows), [rows]);
  // Factory whose chart was clicked (null = none open). If a new run no longer has
  // that factory, the lookup below finds nothing and the drop-down simply stays shut.
  const [selected, setSelected] = useState<string | null>(null);
  const selectedGroup = s.byFactory.find((f) => f.key === selected);

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
            <FactoryDonut
              key={f.key}
              g={f}
              selected={f.key === selected}
              onSelect={() => setSelected((cur) => (cur === f.key ? null : f.key))}
            />
          ))}
        </div>

        {selectedGroup && (
          <FactoryDetail
            key={selectedGroup.key}
            g={selectedGroup}
            seasons={s.byFactorySeason.filter((r) => r.factory === selectedGroup.key)}
            onClose={() => setSelected(null)}
          />
        )}

        {/* Factory totals (one row per factory, + overall Total). Per-season numbers
            open from each factory's chart above. */}
        <section className="summary-card">
          <h2>Factory totals</h2>
          <div className="log-table-wrap">
            <table className="log-table">
              <thead>
                <tr>
                  <th>Factory</th>
                  <th>Match</th>
                  <th>Diff</th>
                  <th>No Key</th>
                  <th>Not Compared</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {s.byFactory.map((r) => (
                  <tr key={r.key}>
                    <td>{r.key}</td>
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
