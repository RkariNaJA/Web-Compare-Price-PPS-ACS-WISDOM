/**
 * The heart of the validator. runComparison() takes:
 *   • ACS data (File A, from DB)
 *   • one or more PPS files (File B, user-uploaded)
 *   • optional Costsheet data (File C, from DB)
 * and produces one CompRow per PPS input row, with a 3-way verdict
 * (LOCAL_QUOTE_AMOUNT vs ACS FOB vs Costsheet Final FOB).
 *
 * Everything here is pure — no React, no fetch. Called on Validate button click.
 */
import type { CompRow, KeyDisplay, PPSFile, Row, TableData } from './types';
import { JOIN_KEY_PAIRS, KEY_PAIRS } from './constants';
import {
  convertBExtendSize,
  convertBSize,
  extractSizeFromCBDID,
  normalizeJoinKey,
} from './normalize';
import { buildCostsheetIndex, lookupCostsheet } from './costsheet';

// Aggregate output for the UI: rows for the table, plus quick counts and any
// non-fatal warnings that should be shown as toasts.
export interface CompareResult {
  rows: CompRow[];
  matchCount: number;
  diffCount: number;
  noKeyCount: number;
  warnings: string[];
  collapsedRows: number;   // raw PPS rows merged away by de-duplication (0 if none)
}

// One ACS row plus its original index — kept together so we can trace back
// which ACS row was picked (useful for debugging, e.g. duplicate CBDIDs).
interface AcsCandidate {
  row: Row;
  idx: number;
}

// Given a list of ACS rows that share the same season+style+color+factory,
// pick the one whose EXTRACTED_SIZE matches the PPS size best. Falls back in
// order: exact → token overlap → substring → any-non-reg → first candidate.
// This is why a PPS row with SIZE_DATA=S can still match an ACS row with
// EXTRACTED_SIZE=ALL_REG_SIZE_RB.
function matchDbRowForSize(
  candidates: AcsCandidate[],
  bRawSize: string,
  bConvertedSize: string,
  sizeAIdx: number,
): AcsCandidate | null {
  if (!candidates.length) return null;
  const rawL = bRawSize.trim().toLowerCase();
  const convL = bConvertedSize.trim().toLowerCase();
  let m =
    candidates.find((c) => String(c.row[sizeAIdx] ?? '').trim().toLowerCase() === convL) || null;
  if (m) return m;
  m =
    candidates.find((c) => {
      const parts = String(c.row[sizeAIdx] ?? '')
        .trim()
        .toLowerCase()
        .split(/[_\-]+/);
      return parts.includes(rawL) || parts.includes(convL);
    }) || null;
  if (m) return m;
  m =
    candidates.find((c) => {
      const dbSz = String(c.row[sizeAIdx] ?? '')
        .trim()
        .toLowerCase();
      return dbSz.includes(rawL) || dbSz.includes(convL);
    }) || null;
  if (m) return m;
  if (convL !== 'all_reg_size_rb') {
    m =
      candidates.find(
        (c) =>
          !String(c.row[sizeAIdx] ?? '')
            .trim()
            .toLowerCase()
            .includes('reg_size'),
      ) || null;
    if (m) return m;
  }
  return candidates[0] || null;
}

// Stable per-row identity for saved annotations. Same fields + normalization as
// the de-dup key (trim + lowercase), plus FTYCODE so it's unique across factories.
// Kept in sync with dedupePPSRows so a saved value maps back to exactly one row.
function makeRowKey(parts: string[]): string {
  return parts.map((p) => p.trim().toLowerCase()).join('|');
}

// dbo.PPS is a quote-history log: the same style/color/size/quote is re-inserted
// over time (only dates/status/comments/developer differ), so a single factory can
// carry ~4× redundant rows. Collapse each PPS file down to one row per validation
// case — (SEASON_YEAR, STYLE, COLOR, <original size>, LOCAL_QUOTE_AMOUNT); FTYCODE
// is constant per file — keeping the newest record by INSERT_DATE. Rows with a
// DIFFERENT quote stay separate (they can have a different verdict), which is
// exactly why LOCAL_QUOTE_AMOUNT is part of the key. Comparison keys are matched
// case-insensitively, so the de-dup key lower-cases too for consistency.
// If the file lacks the expected columns (e.g. a non-DB source), it's left as-is.
//
// IMPORTANT: size uses ORIG_SIZE_DATA (the raw "S", "3XL-T" the table displays),
// NOT SIZE_DATA — FileSlotPPS normalises SIZE_DATA into buckets (S/M/L →
// ALL_REG_SIZE_RB, the -T sizes → ALL_EXTEND_SIZE_RB), which would wrongly merge
// distinct sizes into one row. Fall back to SIZE_DATA only if the original wasn't
// preserved (a non-DB source that never went through FileSlotPPS).
function dedupePPSRows(fileB: PPSFile): Row[] {
  const h = fileB.headers;
  const sizeCol = h.indexOf('ORIG_SIZE_DATA') !== -1 ? 'ORIG_SIZE_DATA' : 'SIZE_DATA';
  const keyIdx = ['SEASON_YEAR', 'STYLE', 'COLOR', sizeCol, 'LOCAL_QUOTE_AMOUNT'].map((c) =>
    h.indexOf(c),
  );
  if (keyIdx.some((i) => i === -1)) return fileB.rows;
  const insertIdx = h.indexOf('INSERT_DATE');

  // First-seen order is preserved for a stable display; the stored row is
  // swapped for a newer one when a later duplicate has a greater INSERT_DATE.
  const winners = new Map<string, Row>();
  const order: string[] = [];
  for (const row of fileB.rows) {
    const key = keyIdx.map((i) => String(row[i] ?? '').trim().toLowerCase()).join('|');
    const current = winners.get(key);
    if (!current) {
      winners.set(key, row);
      order.push(key);
    } else if (insertIdx !== -1) {
      // datetime2 stringifies year-first, so a lexicographic compare picks the newest.
      if (String(row[insertIdx] ?? '') > String(current[insertIdx] ?? '')) {
        winners.set(key, row);
      }
    }
  }
  return order.map((k) => winners.get(k)!);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main comparison entry point. Called from App.tsx when the user clicks Validate.
// Throws (via toast in App) if ACS is missing required columns; warnings are
// non-fatal and returned in the result.
// ─────────────────────────────────────────────────────────────────────────────
export function runComparison(
  dataA: TableData,
  dataBFiles: PPSFile[],
  dataC: TableData | null,
): CompareResult {
  const warnings: string[] = [];

  // Sanity-check required ACS columns exist. If any key column is missing,
  // there's nothing to compare against — fail fast with a clear error.
  const missingA = KEY_PAIRS.filter((kp) => dataA.headers.indexOf(kp.a) === -1).map((kp) => kp.a);
  if (missingA.length) {
    throw new Error(`Missing ACS columns: ${missingA.join(', ')}`);
  }

  // Locate the ACS-specific FOB / CBDID columns. Regex tolerates casing/spaces.
  const finalFobIdx = dataA.headers.findIndex((h) => /^final\s*fob$/i.test(h));
  const extSzFobIdx = dataA.headers.findIndex((h) => /^extszfob$/i.test(h));
  const cbdidIdx = dataA.headers.findIndex((h) => /^cbdid$/i.test(h));
  if (finalFobIdx === -1) throw new Error('Missing "FinalFOB" in ACS DB');
  if (extSzFobIdx === -1) throw new Error('Missing "ExtSzFOB" in ACS DB');
  if (cbdidIdx === -1) throw new Error('Missing "CBDID" in ACS DB');

  const sizeAIdx = dataA.headers.indexOf('EXTRACTED_SIZE');

  // ── Build the ACS index ────────────────────────────────────────────────────
  // Two hash maps so lookups are O(1): with color and without. The no-color
  // variant handles the ALL_SOLID fallback (see below).
  const indexA = new Map<string, AcsCandidate[]>();
  const indexANoColor = new Map<string, AcsCandidate[]>();
  dataA.rows.forEach((row, idx) => {
    const key = JOIN_KEY_PAIRS.map((kp) =>
      normalizeJoinKey(row[dataA.headers.indexOf(kp.a)], kp.a),
    ).join('|');
    if (!indexA.has(key)) indexA.set(key, []);
    indexA.get(key)!.push({ row, idx });

    const keyNC = JOIN_KEY_PAIRS.filter((kp) => kp.a !== 'ColorwayCode')
      .map((kp) => normalizeJoinKey(row[dataA.headers.indexOf(kp.a)], kp.a))
      .join('|');
    if (!indexANoColor.has(keyNC)) indexANoColor.set(keyNC, []);
    indexANoColor.get(keyNC)!.push({ row, idx });
  });

  // ── Build the Costsheet index (only if File C is loaded) ───────────────────
  // Missing costsheet columns aren't fatal — we just warn and skip the 3-way check.
  const cIdx = buildCostsheetIndex(dataC);
  if (cIdx && cIdx.missing.length) {
    warnings.push(`Costsheet missing columns: ${cIdx.missing.join(', ')}`);
  }

  const compRows: CompRow[] = [];
  let globalRow = 0;  // 1-based row counter across all PPS files, shown in the # column
  let rawPPSRows = 0; // total PPS rows across processed files BEFORE de-duplication

  dataBFiles.forEach((fileB) => {
    const bHdr = fileB.headers;
    const localQuoteIdx = bHdr.indexOf('LOCAL_QUOTE_AMOUNT');
    const origSizeIdx = bHdr.indexOf('ORIG_SIZE_DATA');
    const sizeDataIdx = bHdr.indexOf('SIZE_DATA');
    // Display-only PPS columns surfaced before the key columns in the results table.
    const mscIdx = bHdr.indexOf('MSC_CODE');
    const respDevIdx = bHdr.indexOf('RESPONSIBLE_DEVELOPER');
    // Columns that compose the stable row_key used to save annotations.
    const ftyIdx = bHdr.indexOf('FTYCODE');
    const seasonIdx = bHdr.indexOf('SEASON_YEAR');
    const styleIdx = bHdr.indexOf('STYLE');
    const colorIdx = bHdr.indexOf('COLOR');
    if (localQuoteIdx === -1) {
      warnings.push(`"${fileB.name}" missing LOCAL_QUOTE_AMOUNT`);
      return;
    }

    // Collapse this factory's quote-history duplicates to one row per validation
    // case before comparing (see dedupePPSRows above).
    rawPPSRows += fileB.rows.length;
    const dedupedRows = dedupePPSRows(fileB);

    // ── Walk every (de-duplicated) PPS row and match it against ACS + Costsheet ──
    dedupedRows.forEach((rowB) => {
      globalRow++;

      // Size prep: bRawSize is the (already-normalized) SIZE_DATA. If the PPS
      // cell was empty, treat it as the ALL_REG_SIZE_RB group.
      const bRawSize = sizeDataIdx !== -1 ? String(rowB[sizeDataIdx] ?? '').trim() : '';
      const bConvertedSize = bRawSize || 'ALL_REG_SIZE_RB';

      // Display-only values pulled straight from the PPS row.
      const mscCode = mscIdx !== -1 ? String(rowB[mscIdx] ?? '').trim() : '';
      const responsibleDeveloper = respDevIdx !== -1 ? String(rowB[respDevIdx] ?? '').trim() : '';

      // Build the composite join key used to look up ACS candidates.
      const joinKeyStr = JOIN_KEY_PAIRS.map((kp) => {
        const idx = bHdr.indexOf(kp.b);
        return normalizeJoinKey(idx !== -1 ? rowB[idx] : '', kp.a);
      }).join('|');

      const cJoinKey = [
        normalizeJoinKey(
          bHdr.indexOf('SEASON_YEAR') !== -1 ? rowB[bHdr.indexOf('SEASON_YEAR')] : '',
          'Season',
        ),
        normalizeJoinKey(
          bHdr.indexOf('STYLE') !== -1 ? rowB[bHdr.indexOf('STYLE')] : '',
          'StyleNumber',
        ),
        normalizeJoinKey(bHdr.indexOf('COLOR') !== -1 ? rowB[bHdr.indexOf('COLOR')] : '', 'color'),
        normalizeJoinKey(
          bHdr.indexOf('FTYCODE') !== -1 ? rowB[bHdr.indexOf('FTYCODE')] : '',
          'FactoryCode',
        ),
      ].join('|');
      const cJoinKeyNC = [
        normalizeJoinKey(
          bHdr.indexOf('SEASON_YEAR') !== -1 ? rowB[bHdr.indexOf('SEASON_YEAR')] : '',
          'Season',
        ),
        normalizeJoinKey(
          bHdr.indexOf('STYLE') !== -1 ? rowB[bHdr.indexOf('STYLE')] : '',
          'StyleNumber',
        ),
        normalizeJoinKey(
          bHdr.indexOf('FTYCODE') !== -1 ? rowB[bHdr.indexOf('FTYCODE')] : '',
          'FactoryCode',
        ),
      ].join('|');

      // Find ACS candidates by full key. If none AND the PPS color is
      // "ALL_SOLID"-equivalent, fall back to a no-color key.
      let candidates = indexA.get(joinKeyStr) || [];
      if (!candidates.length) {
        const colorNorm = normalizeJoinKey(
          bHdr.indexOf('COLOR') !== -1 ? rowB[bHdr.indexOf('COLOR')] : '',
          'ColorwayCode',
        );
        if (colorNorm === 'all_solid') {
          const keyNC = JOIN_KEY_PAIRS.filter((kp) => kp.a !== 'ColorwayCode')
            .map((kp) => {
              const i = bHdr.indexOf(kp.b);
              return normalizeJoinKey(i !== -1 ? rowB[i] : '', kp.a);
            })
            .join('|');
          candidates = indexANoColor.get(keyNC) || [];
        }
      }

      // Pick the single best ACS row from those candidates (size-based).
      const matchA = matchDbRowForSize(candidates, bRawSize, bConvertedSize, sizeAIdx);
      const rowA = matchA ? matchA.row : null;
      const localQuoteVal = String(rowB[localQuoteIdx] ?? '').trim();

      // Stable identity for saving Error From / Done — survives re-validation and is
      // identical for every user. Same fields as the de-dup key, plus FTYCODE.
      const origSizeVal = origSizeIdx !== -1 ? String(rowB[origSizeIdx] ?? '').trim() : bRawSize;
      const rowKey = makeRowKey([
        ftyIdx !== -1 ? String(rowB[ftyIdx] ?? '') : '',
        seasonIdx !== -1 ? String(rowB[seasonIdx] ?? '') : '',
        styleIdx !== -1 ? String(rowB[styleIdx] ?? '') : '',
        colorIdx !== -1 ? String(rowB[colorIdx] ?? '') : '',
        origSizeVal,
        localQuoteVal,
      ]);

      // Helper: get the user-facing PPS value for a key column. Uses
      // ORIG_SIZE_DATA so we display the original (e.g. "S") not the
      // normalized bucket (e.g. "ALL_REG_SIZE_RB"). Empty COLOR shows as ALL_SOLID.
      const bDisplayVal = (kp: { a: string; b: string }) => {
        if (kp.a === 'EXTRACTED_SIZE') {
          return origSizeIdx !== -1 ? String(rowB[origSizeIdx] ?? '').trim() : bRawSize;
        }
        const i = bHdr.indexOf(kp.b);
        const v = i !== -1 ? String(rowB[i] ?? '').trim() : '';
        if (kp.b === 'COLOR' && v === '') return 'ALL_SOLID';
        return v;
      };

      // Costsheet lookup happens regardless of whether we found an ACS row,
      // so noKeyMatch rows can still show WISDOM data if it exists.
      const cResult = lookupCostsheet(cIdx, bConvertedSize, cJoinKey, cJoinKeyNC);

      // ── HAPPY PATH: ACS row found ────────────────────────────────────────
      if (rowA) {
        const keyDisplay: KeyDisplay[] = KEY_PAIRS.map((kp) => {
          const aVal = String(rowA[dataA.headers.indexOf(kp.a)] ?? '').trim();
          const bVal = bDisplayVal(kp);
          let match = normalizeJoinKey(aVal, kp.a) === normalizeJoinKey(bVal, kp.a);
          if (kp.a === 'EXTRACTED_SIZE') {
            const parts = aVal.toLowerCase().split(/[_\-]+/);
            match =
              parts.includes(bVal.toLowerCase()) ||
              aVal.toLowerCase() === convertBSize(bVal).toLowerCase() ||
              aVal.toLowerCase().includes(bVal.toLowerCase());
          }
          return { aVal, bVal, match, aName: kp.a };
        });

        // Extract size from CBDID for size comparison.
        const rawDbSize = extractSizeFromCBDID(String(rowA[cbdidIdx] ?? '').trim());
        const dbCbdidSize = convertBExtendSize(rawDbSize);

        // FOB source selection:
        //   PPS size == ACS CBDID size  → use FinalFOB (exact size match)
        //   PPS size != ACS CBDID size  → use ExtSzFOB (extended size FOB)
        let fobSource: CompRow['fobSource'];
        let dbFobValue: string;
        if (bConvertedSize.toLowerCase() === dbCbdidSize.toLowerCase()) {
          fobSource = 'FinalFOB';
          dbFobValue = String(rowA[finalFobIdx] ?? '').trim();
        } else {
          fobSource = 'ExtSzFOB';
          dbFobValue = String(rowA[extSzFobIdx] ?? '').trim();
        }

        // Compare LOCAL_QUOTE_AMOUNT vs ACS FOB. Prefer numeric comparison
        // with a tiny epsilon (guards against float drift like 2.8 vs 2.7999999),
        // and only fall back to case-insensitive string equality when either side isn't numeric.
        const numL = parseFloat(localQuoteVal);
        const numF = parseFloat(dbFobValue);
        const lqVsAcs =
          !isNaN(numL) && !isNaN(numF)
            ? Math.abs(numL - numF) < 0.0001
            : localQuoteVal.toLowerCase() === dbFobValue.toLowerCase();

        // Costsheet comparison — only if we found a matching Costsheet row.
        // cMatch stays null when no Costsheet row was found (differs from false =
        // "found but different value" so the UI can render "No CS" separately).
        let cMatch: boolean | null = null;
        let cFobValue = '';
        let cVersionVal = '';
        let cCostSheetNo = '';
        let cDateStr = '';
        if (cResult && cResult.matched) {
          cFobValue = cResult.fobVal;
          cVersionVal = cResult.versionVal;
          cCostSheetNo = cResult.costSheetNoVal;
          cDateStr = cResult.dateStr;
          const numC = parseFloat(cFobValue);
          cMatch =
            !isNaN(numL) && !isNaN(numC)
              ? Math.abs(numL - numC) < 0.0001
              : localQuoteVal.toLowerCase() === cFobValue.toLowerCase();
        }

        // Final 3-way verdict. When Costsheet is loaded, ALL three must agree.
        // When Costsheet isn't loaded, fall back to the 2-way LQ vs ACS check.
        const hasCData = dataC !== null;
        const acsMatch = hasCData ? lqVsAcs && cMatch === true : lqVsAcs;

        compRows.push({
          rowIdx: globalRow,
          rowKey,
          srcFile: fileB.name,
          srcColorIdx: fileB.colorIdx,
          mscCode,
          responsibleDeveloper,
          keys: keyDisplay,
          bSize: bConvertedSize,
          dbCbdidSize,
          fobSource,
          dbFobValue,
          localQuoteVal,
          valueMatch: acsMatch,
          status: 'matched',
          joinKeyStr,
          cFobValue,
          cVersionVal,
          cCostSheetNo,
          cDateStr,
          cMatch,
          cMatched: cResult?.matched ?? false,
          cSizeVal: cResult?.sizeRaw || '',
          cSizeNorm: cResult?.sizeNorm || '',
          lqVsAcs,
        });
      // ── NO-KEY-MATCH PATH: no ACS row found for this PPS row ────────────
      // We still emit a CompRow so it shows up in the table with a diagnostic:
      // which colours ACS has for this key (so the user can eyeball the mismatch).
      } else {
        const keyDisplay: KeyDisplay[] = KEY_PAIRS.map((kp) => ({
          aVal: '',
          bVal: bDisplayVal(kp),
          match: false,
          aName: kp.a,
        }));
        // Diagnostic: which colours does ACS have for this season+style+factory?
        // Helps the user spot the specific typo/mismatch when a match was expected.
        const keyNCDiag = JOIN_KEY_PAIRS.filter((kp) => kp.a !== 'ColorwayCode')
          .map((kp) => {
            const i = bHdr.indexOf(kp.b);
            return normalizeJoinKey(i !== -1 ? rowB[i] : '', kp.a);
          })
          .join('|');
        const dbColorsForKey = (indexANoColor.get(keyNCDiag) || [])
          .map(
            (c) =>
              String(c.row[dataA.headers.indexOf('ColorwayCode')] ?? '').trim() || '(empty)',
          )
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 6);

        let cMatch: boolean | null = null;
        let cFobValue = '';
        let cVersionVal = '';
        let cCostSheetNo = '';
        let cDateStr = '';
        if (cResult && cResult.matched) {
          cFobValue = cResult.fobVal;
          cVersionVal = cResult.versionVal;
          cCostSheetNo = cResult.costSheetNoVal;
          cDateStr = cResult.dateStr;
          const numC = parseFloat(cFobValue);
          const numL2 = parseFloat(localQuoteVal);
          cMatch =
            !isNaN(numL2) && !isNaN(numC)
              ? Math.abs(numL2 - numC) < 0.0001
              : localQuoteVal.toLowerCase() === cFobValue.toLowerCase();
        }

        compRows.push({
          rowIdx: globalRow,
          rowKey,
          srcFile: fileB.name,
          srcColorIdx: fileB.colorIdx,
          mscCode,
          responsibleDeveloper,
          keys: keyDisplay,
          bSize: bConvertedSize,
          dbCbdidSize: '',
          fobSource: 'N/A',
          dbFobValue: '',
          localQuoteVal,
          valueMatch: false,
          status: 'noKeyMatch',
          joinKeyStr,
          dbHasKey: indexA.has(joinKeyStr),
          dbColorsForKey,
          cFobValue,
          cVersionVal,
          cCostSheetNo,
          cDateStr,
          cMatch,
          cMatched: cResult?.matched ?? false,
          cSizeVal: cResult?.sizeRaw || '',
          cSizeNorm: cResult?.sizeNorm || '',
          lqVsAcs: false,
        });
      }
    });
  });

  // Tally quick stats for the toolbar / toast message.
  const matchCount = compRows.filter((r) => r.valueMatch).length;
  const diffCount = compRows.filter((r) => r.status === 'matched' && !r.valueMatch).length;
  const noKeyCount = compRows.filter((r) => r.status === 'noKeyMatch').length;

  // How many raw PPS rows were merged away by de-duplication (0 if none).
  const collapsedRows = rawPPSRows - compRows.length;

  return { rows: compRows, matchCount, diffCount, noKeyCount, warnings, collapsedRows };
}
