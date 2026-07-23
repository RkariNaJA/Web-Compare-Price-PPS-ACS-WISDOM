/**
 * Small pure helpers for normalising values so ACS / PPS / Costsheet rows
 * can be compared even when they store the same thing in slightly different
 * shapes (casing, whitespace, suffixes, aliases, date formats, etc.).
 *
 * Everything here is deterministic and side-effect-free — safe to unit test in isolation.
 */
import { EXTEND_SIZE, REG_SIZES, C_KEY_ALIASES, C_KEY_MAP } from './constants';

// Turn any cell value into a comparable string for join-key equality.
// Strips whitespace, lowercases, and folds "empty / ALL_HTR / ALL_AOP / RETAIL / SOLID1"
// into a single "all_solid" bucket so those colourway variants match interchangeably.
export function normalizeJoinKey(value: unknown, dbColName: string): string {
  let s = String(value ?? '').replace(/\s+/g, '').toLowerCase();
  if (
    (dbColName === 'ColorwayCode' ||
      dbColName === 'COLOR' ||
      dbColName === 'color' ||
      dbColName === 'Color') &&
    (s === '' || s === 'all_htr' || s === 'all_aop' || s === 'retail' || s === 'solid1')
  ) {
    s = 'all_solid';
  }
  return s;
}

// If the size is a "regular" size (S, M, L, 40, 3-6, …), collapse it to the
// group bucket ALL_REG_SIZE_RB. Anything else passes through untouched.
export function convertBSize(size: unknown): string {
  const s = String(size).trim();
  return REG_SIZES.includes(s) ? 'ALL_REG_SIZE_RB' : s;
}

// Same idea as convertBSize but for tall / extended sizes.
export function convertBExtendSize(size: unknown): string {
  const s = String(size).trim();
  return EXTEND_SIZE.includes(s) ? 'ALL_EXTEND_SIZE_RB' : s;
}

// Full pipeline: try REG first, then EXTEND. Empty strings become ALL_REG_SIZE_RB
// so a PPS row missing SIZE_DATA still lands in a real bucket instead of an empty one.
export function normalizeSizeToken(raw: unknown): string {
  let s = convertBSize(String(raw).trim());
  if (s !== 'ALL_REG_SIZE_RB') s = convertBExtendSize(s);
  return s || 'ALL_REG_SIZE_RB';
}

// ACS stores size at the end of CBDID like:
//   SU27-HTV-HV8232-S-ALL_SOLID-ALL_REG_SIZE-RB   →   ALL_REG_SIZE_RB
// The last two dash-separated segments are joined with underscore. If the CBDID
// has fewer than 6 segments we can't extract cleanly, so we just return it as-is.
export function extractSizeFromCBDID(cbdid: unknown): string {
  const s = String(cbdid).trim();
  if (!s) return '';
  const parts = s.split('-');
  if (parts.length < 6) return s;
  return parts.slice(5).join('_');
}

// Parse a date coming from the SQL backend (as string) or an Excel serial (as number).
// 25569 = the offset between the Excel 1900 epoch and the JS 1970 epoch, in days.
// Returns null on invalid so callers can skip that record cleanly.
export function parseDate(val: unknown): Date | null {
  if (val == null || val === '') return null;
  if (typeof val === 'number') {
    const d = new Date((val - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(val));
  return isNaN(d.getTime()) ? null : d;
}

// Normalise a header string for tolerant comparison: drop whitespace / underscores /
// dots / hyphens, then lowercase. So "Final FOB" == "FinalFOB" == "Final_FOB".
function normCColName(s: unknown): string {
  return String(s ?? '').replace(/[\s_.\-]+/g, '').toLowerCase();
}

// Find which column index in a Costsheet header row corresponds to a logical key.
// Tries every alias in C_KEY_ALIASES plus the "preferred" name in C_KEY_MAP.
// Returns -1 if nothing matched — callers use that to warn about missing columns.
export function findCostsheetIdx(hdr: string[], key: keyof typeof C_KEY_MAP): number {
  const wanted = new Set((C_KEY_ALIASES[key] || []).map(normCColName));
  const want = normCColName(C_KEY_MAP[key] || '');
  if (want) wanted.add(want);
  for (let i = 0; i < hdr.length; i++) {
    if (wanted.has(normCColName(hdr[i]))) return i;
  }
  return -1;
}
