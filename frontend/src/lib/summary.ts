/**
 * Pure aggregation for the Validation Summary view. Turns the current run's CompRows
 * into Match / Diff / No Key counts, grouped by factory, by season, and by (factory ×
 * season). No React — just data in, data out (so it's trivially testable).
 *
 * Verdict mapping (identical to the results toolbar, via verdictOf — see comparison.ts):
 *   No Key = status 'noKeyMatch'  ·  Not Compared = comparable is false  ·
 *   Match = valueMatch  ·  Diff = matched, comparable, but not equal
 */
import type { CompRow } from './types';
import { verdictOf, type Verdict } from './comparison';

export interface VerdictCounts {
  match: number;
  diff: number;
  noKey: number;
  notCompared: number;
  total: number;
}
export interface GroupCount extends VerdictCounts {
  key: string; // factory code or season
}
export interface FactorySeasonRow extends VerdictCounts {
  factory: string;
  season: string;
}
export interface Summary {
  totals: VerdictCounts;
  byFactory: GroupCount[]; // sorted by total desc
  bySeason: GroupCount[]; // sorted by total desc
  byFactorySeason: FactorySeasonRow[]; // sorted by factory, then season
}

const seasonOf = (r: CompRow) => r.keys.find((k) => k.aName === 'Season')?.bVal || '—';
const factoryOf = (r: CompRow) => r.keys.find((k) => k.aName === 'FactoryCode')?.bVal || '—';

const blank = (): VerdictCounts => ({ match: 0, diff: 0, noKey: 0, notCompared: 0, total: 0 });
const bump = (c: VerdictCounts, v: Verdict) => {
  c[v] += 1;
  c.total += 1;
};

export function summarize(rows: CompRow[]): Summary {
  const totals = blank();
  const fac = new Map<string, VerdictCounts>();
  const sea = new Map<string, VerdictCounts>();
  const facSea = new Map<string, FactorySeasonRow>();

  for (const r of rows) {
    const f = factoryOf(r);
    const s = seasonOf(r);
    const v = verdictOf(r);
    bump(totals, v);
    if (!fac.has(f)) fac.set(f, blank());
    bump(fac.get(f)!, v);
    if (!sea.has(s)) sea.set(s, blank());
    bump(sea.get(s)!, v);
    const fsKey = `${f}||${s}`;
    if (!facSea.has(fsKey)) facSea.set(fsKey, { factory: f, season: s, ...blank() });
    bump(facSea.get(fsKey)!, v);
  }

  const toGroups = (m: Map<string, VerdictCounts>): GroupCount[] =>
    [...m.entries()].map(([key, c]) => ({ key, ...c })).sort((a, b) => b.total - a.total);

  const byFactorySeason = [...facSea.values()].sort(
    (a, b) => a.factory.localeCompare(b.factory) || a.season.localeCompare(b.season),
  );

  return { totals, byFactory: toGroups(fac), bySeason: toGroups(sea), byFactorySeason };
}
