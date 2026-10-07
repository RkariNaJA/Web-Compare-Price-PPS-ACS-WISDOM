/**
 * Per-source results for the cards above the results table: how many PPS rows
 * each source covered, and how often its FOB agreed. Pure — no React.
 *
 * Counts are over ALL compared rows (not the filtered view), so the cards describe
 * the validation run itself.
 */
import type { CompRow } from './types';

export interface SourceResult {
  found: number;     // PPS rows that found a row in this source
  compared: number;  // of those, rows whose FOB could be compared (preferred currency)
  agree: number;     // of those, rows whose FOB agreed with LOCAL_QUOTE_AMOUNT
}

export interface SourceStats {
  total: number;                                          // PPS rows compared
  pps: { name: string; colorIdx: number; rows: number }[]; // per factory, first-seen order
  acs: SourceResult;
  cs: SourceResult;
}

type StatRow = Pick<
  CompRow,
  'srcFile' | 'srcColorIdx' | 'status' | 'comparable' | 'lqVsAcs' | 'cMatched' | 'cMatch'
>;

export function sourceStats(rows: StatRow[]): SourceStats {
  const pps = new Map<string, { name: string; colorIdx: number; rows: number }>();
  const acs: SourceResult = { found: 0, compared: 0, agree: 0 };
  const cs: SourceResult = { found: 0, compared: 0, agree: 0 };
  for (const r of rows) {
    const f = pps.get(r.srcFile) ?? { name: r.srcFile, colorIdx: r.srcColorIdx, rows: 0 };
    f.rows++;
    pps.set(r.srcFile, f);

    if (r.status === 'matched') {
      acs.found++;
      if (r.comparable) {
        acs.compared++;
        if (r.lqVsAcs) acs.agree++;
      }
    }
    if (r.cMatched) {
      cs.found++;
      if (r.comparable) {
        cs.compared++;
        if (r.cMatch === true) cs.agree++;
      }
    }
  }
  return { total: rows.length, pps: [...pps.values()], acs, cs };
}
