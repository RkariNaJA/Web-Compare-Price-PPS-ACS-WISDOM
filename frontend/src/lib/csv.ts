/**
 * CSV export for the results table.
 *
 * Produces a spreadsheet with one row per compared PPS row plus an explicit
 * Verdict column (MATCH / DIFF / NO_KEY_MATCH) and a Diff_Reason so the user
 * can filter for problem rows in Excel with a single click.
 */
import type { CompRow, RowAnnotation } from './types';

// Escape a value for a CSV field: wrap in quotes if it contains a quote, comma,
// or newline; double up any interior quotes per RFC 4180.
function csvCell(v: unknown): string {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Verdict mirrors the on-screen badge exactly so filtering the CSV in Excel
// matches the "Match / Diff / No Key" toolbar filter the user might already know.
function verdict(r: CompRow): 'MATCH' | 'DIFF' | 'NO_KEY_MATCH' {
  if (r.status === 'noKeyMatch') return 'NO_KEY_MATCH';
  return r.valueMatch ? 'MATCH' : 'DIFF';
}

// For DIFF rows only: build a pipe-delimited reason string like "PPS!=ACS|No_WISDOM"
// so Excel filters can group by failure mode. Empty for MATCH / NO_KEY_MATCH rows.
function diffReason(r: CompRow, hasC: boolean): string {
  if (r.status !== 'matched' || r.valueMatch) return '';
  const parts: string[] = [];
  if (r.lqVsAcs === false) parts.push('PPS!=ACS');
  if (hasC && r.cMatched && r.cMatch === false) parts.push('PPS!=WISDOM');
  if (hasC && !r.cMatched) parts.push('No_WISDOM');
  return parts.join('|');
}

// Build the CSV in memory, drop a Blob URL into a temporary <a>, click it.
// Exports ALL rows (compRows), NOT the currently-filtered table view — so
// users always get the full dataset regardless of what filter is active.
// `annotations` carries the user-typed Error From / Done values (keyed by
// rowIdx); it's optional so older callers still work.
export function exportComparisonCSV(
  rows: CompRow[],
  hasC: boolean,
  annotations: Record<string, RowAnnotation> = {},
) {
  if (!rows.length) return;
  const hdr = [
    'Row',
    'MSC_CODE',
    'RESPONSIBLE_DEVELOPER',
    'Season_B',
    'Size_B',
    'Style_B',
    'Color_B',
    'Factory_B',
    'B_Size_Converted',
    'DB_CBDID_Size',
    'FOB_Source',
    'ACS_FOB_Value',
    'LOCAL_QUOTE_AMOUNT',
    ...(hasC ? ['Costsheet_Final_FOB', 'Costsheet_Max_Input_Date'] : []),
    // User-filled columns (not DB-sourced) — mirror the on-screen table order,
    // sitting just before the Verdict.
    'Error_From',
    'Done',
    'Saved_By',
    'Verdict',
    'Diff_Reason',
  ];
  const lines = [hdr.map(csvCell).join(',')];
  rows.forEach((r) => {
    const ann = annotations[r.rowKey];
    lines.push(
      [
        r.rowIdx,
        r.mscCode,
        r.responsibleDeveloper,
        ...r.keys.map((k) => k.bVal),
        r.bSize,
        r.dbCbdidSize,
        r.fobSource,
        r.dbFobValue,
        r.localQuoteVal,
        ...(hasC ? [r.cFobValue || '', r.cDateStr || ''] : []),
        ann?.errorFrom || '',
        ann?.done ? 'Yes' : '',
        ann?.savedBy || '',
        verdict(r),
        diffReason(r, hasC),
      ]
        .map(csvCell)
        .join(','),
    );
  });
  // Trigger browser download via a synthetic anchor click.
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = 'local_quote_validation.csv';
  a.click();
}
