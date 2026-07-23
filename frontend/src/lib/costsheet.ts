/**
 * Costsheet (File C / WISDOM) index + lookup.
 *
 * Costsheet rows are grouped into two hash maps by their join key so that,
 * for any PPS row, we can find candidate Costsheet rows in O(1) and then
 * pick the best one by size + MAX(First Input Date).
 */
import type { Row, TableData } from './types';
import { C_KEY_MAP } from './constants';
import {
  findCostsheetIdx,
  normalizeJoinKey,
  normalizeSizeToken,
  parseDate,
} from './normalize';

// One preprocessed Costsheet row — everything we need for matching without
// re-reading the header indices each time.
export interface CostsheetEntry {
  row: Row;
  szNorm: string;   // size after normalization (used for matching)
  szRaw: string;    // size as displayed to the user
  dateVal: Date | null;  // First Input Date parsed; null if missing/unparseable
  fobVal: string;   // Final FOB as a trimmed string
  versionVal: string;      // CBD Version as a trimmed string
  costSheetNoVal: string;  // Cost Sheet No. as a trimmed string
}

// The full precomputed index. rawIndex is keyed by season|style|color|factory;
// rawIndexNoColor drops the color segment so ALL_SOLID PPS rows can fall back.
export interface CostsheetIndex {
  rawIndex: Map<string, CostsheetEntry[]>;
  rawIndexNoColor: Map<string, CostsheetEntry[]>;
  fobIdx: number;
  dateIdx: number;
  missing: string[];  // names of required columns that couldn't be found in the headers
}

// Return shape from lookupCostsheet — what runComparison stitches onto each CompRow.
export interface CostsheetMatch {
  fobVal: string;
  dateStr: string;    // YYYY-MM-DD in LOCAL time (not UTC — see date formatting note below)
  sizeRaw: string;
  sizeNorm: string;
  versionVal: string;      // CBD Version of the winning Costsheet row
  costSheetNoVal: string;  // Cost Sheet No. of the winning Costsheet row
  matched: boolean;   // false = nothing suitable found
}

/**
 * Preprocess the raw Costsheet TableData into fast lookup structures.
 * Called once when File C is loaded / cleared / refreshed. Everything expensive
 * (date parsing, key building, alias-tolerant header resolution) happens here.
 */
export function buildCostsheetIndex(dc: TableData | null): CostsheetIndex | null {
  if (!dc) return null;
  const hdr = dc.headers;

  // Resolve each logical column against the actual view headers (tolerant of aliases).
  const seasonIdx = findCostsheetIdx(hdr, 'season');
  const styleIdx = findCostsheetIdx(hdr, 'style');
  const colorIdx = findCostsheetIdx(hdr, 'color');
  const factoryIdx = findCostsheetIdx(hdr, 'factory');
  const sizeIdx = findCostsheetIdx(hdr, 'size');
  const fobIdx = findCostsheetIdx(hdr, 'fob');
  const dateIdx = findCostsheetIdx(hdr, 'date');
  // Extra display-only columns — absence is not fatal (they just render as em-dashes).
  const versionIdx = findCostsheetIdx(hdr, 'version');
  const costSheetNoIdx = findCostsheetIdx(hdr, 'costSheetNo');

  // Collect any critical columns that couldn't be resolved — the toolbar will warn the user.
  const missing: string[] = [];
  if (fobIdx === -1) missing.push(`FOB ("${C_KEY_MAP.fob}")`);
  if (dateIdx === -1) missing.push(`Date ("${C_KEY_MAP.date}")`);
  if (seasonIdx === -1) missing.push('Season');
  if (styleIdx === -1) missing.push('Style');
  if (factoryIdx === -1) missing.push('Factory');

  const rawIndex = new Map<string, CostsheetEntry[]>();
  const rawIndexNoColor = new Map<string, CostsheetEntry[]>();

  // Walk every Costsheet row and bucket it into the two maps.
  dc.rows.forEach((row) => {
    // Normalize the raw size: bare "ALL_REG_SIZE" / "ALL_EXTEND_SIZE" get the _RB suffix
    // so they line up with how PPS/ACS represent group sizes.
    let szRaw = sizeIdx !== -1 ? String(row[sizeIdx] ?? '').trim() : '';
    const szUp = szRaw.toUpperCase();
    if (szUp === 'ALL_REG_SIZE') szRaw = 'ALL_REG_SIZE_RB';
    if (szUp === 'ALL_EXTEND_SIZE') szRaw = 'ALL_EXTEND_SIZE_RB';
    const szNorm = normalizeSizeToken(szRaw);
    const dateVal = dateIdx !== -1 ? parseDate(row[dateIdx]) : null;
    const fobVal = fobIdx !== -1 ? String(row[fobIdx] ?? '').trim() : '';
    const versionVal = versionIdx !== -1 ? String(row[versionIdx] ?? '').trim() : '';
    const costSheetNoVal = costSheetNoIdx !== -1 ? String(row[costSheetNoIdx] ?? '').trim() : '';

    const entry: CostsheetEntry = { row, szNorm, szRaw, dateVal, fobVal, versionVal, costSheetNoVal };

    // Full 4-part key (color included)
    const key = [
      normalizeJoinKey(seasonIdx !== -1 ? row[seasonIdx] : '', 'Season'),
      normalizeJoinKey(styleIdx !== -1 ? row[styleIdx] : '', 'StyleNumber'),
      normalizeJoinKey(colorIdx !== -1 ? row[colorIdx] : '', 'color'),
      normalizeJoinKey(factoryIdx !== -1 ? row[factoryIdx] : '', 'FactoryCode'),
    ].join('|');
    if (!rawIndex.has(key)) rawIndex.set(key, []);
    rawIndex.get(key)!.push(entry);

    // 3-part key without color — used as a fallback when the PPS row is ALL_SOLID
    // and nothing matched the full key.
    const keyNoColor = [
      normalizeJoinKey(seasonIdx !== -1 ? row[seasonIdx] : '', 'Season'),
      normalizeJoinKey(styleIdx !== -1 ? row[styleIdx] : '', 'StyleNumber'),
      normalizeJoinKey(factoryIdx !== -1 ? row[factoryIdx] : '', 'FactoryCode'),
    ].join('|');
    if (!rawIndexNoColor.has(keyNoColor)) rawIndexNoColor.set(keyNoColor, []);
    rawIndexNoColor.get(keyNoColor)!.push(entry);
  });

  return { rawIndex, rawIndexNoColor, fobIdx, dateIdx, missing };
}

/**
 * For a single PPS row, find the best Costsheet match:
 *   1. Look up candidates by full key, then no-color fallback.
 *   2. Filter to rows matching the PPS size (with progressive fallbacks).
 *   3. Within that size-matched set, pick the row with MAX(First Input Date).
 */
export function lookupCostsheet(
  cIdx: CostsheetIndex | null,
  bConvertedSize: string,
  joinKeyStr: string,
  keyNoColor: string,
): CostsheetMatch | null {
  if (!cIdx) return null;

  // Step 1 — join key lookup (full, then no-color).
  let candidates = cIdx.rawIndex.get(joinKeyStr) || [];
  if (!candidates.length) {
    candidates = cIdx.rawIndexNoColor.get(keyNoColor) || [];
  }

  const empty: CostsheetMatch = {
    fobVal: '',
    dateStr: '',
    sizeRaw: '',
    sizeNorm: '',
    versionVal: '',
    costSheetNoVal: '',
    matched: false,
  };
  if (!candidates.length) return empty;

  // Step 2 — size filter. Try exact first, then a looser token-based match, then last-resort "any size".
  const convL = bConvertedSize.toLowerCase();
  let sized = candidates.filter((c) => c.szNorm.toLowerCase() === convL);
  if (!sized.length) {
    sized = candidates.filter((c) => {
      const parts = c.szNorm.toLowerCase().split(/[_\-]+/);
      return parts.some((p) => p === convL) || c.szNorm.toLowerCase().includes(convL);
    });
  }
  if (!sized.length) sized = candidates;

  // Step 3 — pick the entry with the latest First Input Date.
  // Records without a parseable date are skipped (they can't win a MAX comparison).
  const best = sized.reduce<CostsheetEntry | null>((prev, cur) => {
    if (!prev) return cur;
    if (!cur.dateVal) return prev;
    if (!prev.dateVal) return cur;
    return cur.dateVal > prev.dateVal ? cur : prev;
  }, null);

  if (!best) return empty;

  // Format the winning record's First Input Date as YYYY-MM-DD in *local* time.
  // Previously used toISOString(), which converts to UTC and shifted the date
  // back by one day for users east of UTC (e.g. Bangkok UTC+7: 2026-05-07 → "2026-05-06").
  // Reading getFullYear / getMonth / getDate keeps the calendar day the DB reported.
  const d = best.dateVal;
  const dateStr = d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(best.row[cIdx.dateIdx] ?? '');

  return {
    fobVal: best.fobVal,
    dateStr,
    sizeRaw: best.szRaw || '',
    sizeNorm: best.szNorm || '',
    versionVal: best.versionVal || '',
    costSheetNoVal: best.costSheetNoVal || '',
    matched: true,
  };
}
