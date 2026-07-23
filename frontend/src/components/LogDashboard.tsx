/**
 * Admin-only Log view (reached from the header switcher / landing chooser).
 * Three cards: who's online now (live, auto-refreshing), who logged in during the
 * selected week, and the annotation change history for that week. Read-only.
 * Logins/Changes are scoped to a Sunday–Saturday week and default to the current
 * week (which rolls over at Sunday midnight); use ◀ / ▶ to look back. Every call
 * is manager-gated on the backend. Styling follows the washi/sumi design system.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchChanges, fetchLogins, fetchPresence } from '../lib/api';
import type { ActiveUser, ChangeEvent, LoginEvent } from '../lib/types';
import { useToast } from '../hooks/useToast';

// Local 'YYYY-MM-DD' for today (matches the backend's local-day handling).
const todayLocal = () => new Date().toLocaleDateString('en-CA');
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
};
const ago = (secs: number) => (secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`);

// Week helpers — the backend resolves any date to its Sunday–Saturday week; these
// are just for the label + navigation on the client.
const shiftDays = (dateStr: string, n: number) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};
const weekSunday = (dateStr: string) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - d.getDay()); // getDay(): Sun=0 → 0 days back
  return d;
};
const weekLabel = (dateStr: string) => {
  const sun = weekSunday(dateStr);
  const sat = new Date(sun);
  sat.setDate(sun.getDate() + 6);
  const fmt = (dt: Date) => dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(sun)} – ${fmt(sat)}, ${sat.getFullYear()}`;
};

export default function LogDashboard() {
  const toast = useToast();
  const [active, setActive] = useState<ActiveUser[]>([]);
  const [day, setDay] = useState(todayLocal()); // any date in the shown week; backend snaps to its week
  const [logins, setLogins] = useState<LoginEvent[]>([]);
  const [changes, setChanges] = useState<ChangeEvent[]>([]);

  // "current week" = the week that contains today; used to cap forward navigation.
  const onCurrentWeek = weekSunday(day).getTime() >= weekSunday(todayLocal()).getTime();

  // Live "online now" — refresh every 15s.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchPresence()
        .then((a) => alive && setActive(a))
        .catch((err) => alive && toast((err as Error).message, 'err'));
    load();
    const id = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [toast]);

  // Logins + changes for the selected week.
  const loadWeek = useCallback(() => {
    fetchLogins(day)
      .then(setLogins)
      .catch((err) => toast((err as Error).message, 'err'));
    fetchChanges(day)
      .then(setChanges)
      .catch((err) => toast((err as Error).message, 'err'));
  }, [day, toast]);

  useEffect(() => loadWeek(), [loadWeek]);

  return (
    <div className="log-dashboard">
      <div className="log-inner">
        {/* Online now */}
        <section className="log-card">
          <div className="log-card-head">
            <h2>Online now</h2>
            <span className="count">{active.length}</span>
            <span className="log-live">
              <span className="dot" /> live · last 2 min
            </span>
          </div>
          {active.length === 0 ? (
            <p className="log-empty">Nobody active right now.</p>
          ) : (
            <div className="log-presence">
              {active.map((u) => (
                <span key={u.username} className="log-user" title={u.username}>
                  <span className="dot" />
                  {u.display_name || u.username}
                  <span className="ago">{ago(u.seconds_ago)} ago</span>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Week navigator — drives the two panels below */}
        <div className="log-daybar">
          <button className="btn btn-ghost" onClick={() => setDay(shiftDays(day, -7))} title="Previous week">
            ◀
          </button>
          <span className="log-week">{weekLabel(day)}</span>
          <button
            className="btn btn-ghost"
            onClick={() => setDay(shiftDays(day, 7))}
            disabled={onCurrentWeek}
            title="Next week"
          >
            ▶
          </button>
          {!onCurrentWeek && (
            <button className="btn btn-ghost" onClick={() => setDay(todayLocal())}>
              This week
            </button>
          )}
        </div>

        {/* Logins */}
        <section className="log-card">
          <div className="log-card-head">
            <h2>Logins</h2>
            <span className="count">{logins.length}</span>
          </div>
          {logins.length === 0 ? (
            <p className="log-empty">No logins this week.</p>
          ) : (
            <div className="log-table-wrap">
              <table className="log-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {logins.map((l, i) => (
                    <tr key={i}>
                      <td className="mono">{timeOf(l.at)}</td>
                      <td title={l.username}>{l.display_name || l.username}</td>
                      <td>{l.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Changes */}
        <section className="log-card">
          <div className="log-card-head">
            <h2>Changes</h2>
            <span className="count">{changes.length}</span>
          </div>
          {changes.length === 0 ? (
            <p className="log-empty">No changes this week.</p>
          ) : (
            <div className="log-table-wrap">
              <table className="log-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Who</th>
                    <th>Row</th>
                    <th>Field</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{timeOf(c.at)}</td>
                      <td>{c.username}</td>
                      <td>
                        <span className="log-rowkey" title={c.row_key}>
                          {c.row_key}
                        </span>
                      </td>
                      <td>{c.field}</td>
                      <td>
                        <span className="log-change-old">{c.old_value || '—'}</span>
                        <span className="log-change-arrow">→</span>
                        <strong>{c.new_value || '—'}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
