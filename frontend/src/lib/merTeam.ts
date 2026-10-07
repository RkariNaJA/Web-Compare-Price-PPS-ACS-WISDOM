/**
 * Team Mer resolution. A results row's team comes from who created its CBD in
 * WISDOM (`Created CBD by` on the winning Costsheet row), looked up in the master
 * file served by GET /get_mer_team_master. Pure — no React, no fetch.
 */
import type { CompRow } from './types';

// Lower-cased MER_DEV → that developer's team(s), as served by the backend.
export type MerTeamMaster = Record<string, string[]>;

// Shown instead of a team so unassignable rows can be filtered and fixed.
export const NO_COSTSHEET = '(No Costsheet)';
export const UNASSIGNED = '(Unassigned)';

// The row's team list. A developer in several teams belongs to all of them, so a
// filter on any of those teams keeps the row. Always returns a fresh array.
export function merTeamsFor(
  createdBy: string,
  cMatched: boolean,
  master: MerTeamMaster | null,
): string[] {
  if (!cMatched) return [NO_COSTSHEET];
  const key = createdBy.trim().toLowerCase();
  // hasOwn guard: the master is a plain JSON object, so `master['constructor']`
  // would otherwise return Object.prototype members.
  const teams =
    key && master && Object.prototype.hasOwnProperty.call(master, key) ? master[key] : null;
  return Array.isArray(teams) && teams.length ? [...teams] : [UNASSIGNED];
}

// Filter dropdown options: real teams A→Z, then the two labels (only if present).
export function merTeamOptions(rows: Pick<CompRow, 'merTeams'>[]): string[] {
  const all = new Set<string>();
  rows.forEach((r) => r.merTeams.forEach((t) => all.add(t)));
  const real = [...all].filter((t) => t !== UNASSIGNED && t !== NO_COSTSHEET).sort();
  return [...real, ...[UNASSIGNED, NO_COSTSHEET].filter((t) => all.has(t))];
}
