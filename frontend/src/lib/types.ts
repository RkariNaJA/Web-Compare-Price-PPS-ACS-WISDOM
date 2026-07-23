/**
 * Shared TypeScript types for the PPS · ACS · WISDOM 3-way validator.
 * Every module in src/ imports its data shapes from this file so the whole
 * app agrees on what a "row", a "PPS file", or a compared row looks like.
 */

// A raw cell in any tabular data — SQL Server values come out as strings from
// the Flask backend, but XLSX rows can contain numbers, and empty cells may be null.
export type Row = (string | number | null)[];

// Generic tabular payload returned by the backend for File A (ACS) and File C (Costsheet).
export interface TableData {
  name: string;
  headers: string[];
  rows: Row[];
}

// A user-uploaded PPS spreadsheet. colorIdx picks a colour from FILE_COLORS
// so each file's rows are visually distinguishable in the output table.
export interface PPSFile {
  name: string;
  headers: string[];
  rows: Row[];
  colorIdx: number;
}

// Pairs an ACS column name (a) with the equivalent PPS column name (b).
// Used for join keys and side-by-side key display.
export interface KeyPair {
  a: string;
  b: string;
}

// One key column for a comparison row — shows the ACS value, PPS value, and
// whether they match. Rendered as the coloured key cells in the output table.
export interface KeyDisplay {
  aVal: string;
  bVal: string;
  match: boolean;
  aName: string;
}

export type RowStatus = 'matched' | 'noKeyMatch';
export type FobSource = 'FinalFOB' | 'ExtSzFOB' | 'N/A';

// One row in the results table. Produced by runComparison() — one CompRow
// per PPS input row. Carries everything needed to render the row and the CSV.
export interface CompRow {
  rowIdx: number;              // 1-based row counter across all PPS files (ephemeral; display only)
  rowKey: string;              // STABLE identity for saving annotations: FTYCODE|Season|Style|Color|ORIG_SIZE|LOCAL_QUOTE_AMOUNT (normalized). Matches the de-dup key.
  srcFile: string;             // filename of the PPS file this row came from (used by search)
  srcColorIdx: number;         // index into FILE_COLORS for the source badge
  mscCode: string;             // MSC_CODE from the uploaded PPS file (shown before Season)
  responsibleDeveloper: string; // RESPONSIBLE_DEVELOPER from the uploaded PPS file (shown before Season)
  keys: KeyDisplay[];          // one entry per KEY_PAIRS entry
  bSize: string;               // PPS size after normalization (e.g. ALL_REG_SIZE_RB)
  dbCbdidSize: string;         // ACS size extracted from CBDID
  fobSource: FobSource;        // which ACS FOB column was used
  dbFobValue: string;          // the ACS FOB value picked
  localQuoteVal: string;       // PPS LOCAL_QUOTE_AMOUNT
  valueMatch: boolean;         // the on-screen "Match/Diff" verdict
  status: RowStatus;           // 'matched' = key hit, 'noKeyMatch' = no ACS row found
  joinKeyStr: string;          // debug string of the composite key

  /* Costsheet (WISDOM) fields — populated when File C is loaded */
  cFobValue: string;           // Costsheet Final FOB
  cVersionVal: string;         // Costsheet "CBD Version" (shown as "Version")
  cCostSheetNo: string;        // Costsheet "Cost Sheet No."
  cDateStr: string;            // "First Input Date" of the winning Costsheet row (YYYY-MM-DD, local)
  cMatch: boolean | null;      // did LOCAL_QUOTE_AMOUNT equal Costsheet Final FOB?
  cMatched: boolean;           // did we even find a Costsheet row for this key/size?
  cSizeVal: string;            // raw size string from the Costsheet row
  cSizeNorm: string;           // normalized size (for matching against PPS)

  /* diagnostics — power the "Diff reason" hints and the No Key Match message */
  lqVsAcs: boolean;            // did LOCAL_QUOTE_AMOUNT equal ACS FOB? (2-way piece of the 3-way)
  dbHasKey?: boolean;          // (noKeyMatch only) does ACS have ANY row for this key?
  dbColorsForKey?: string[];   // (noKeyMatch only) up to 6 colours seen in DB for this key
}

// User-typed annotations on a results row. These two columns are NOT sourced
// from any database — the user fills them in on-screen to triage results, and
// they are kept in App state keyed by CompRow.rowIdx (see App.tsx).
export interface RowAnnotation {
  errorFrom: string;   // "Error From" dropdown: '' (= "-", unassigned), Developer, Wisdom, or Customer
  done: boolean;       // the "Done" checkbox
  savedBy?: string;    // who last saved this row (from the server; blank for unsaved local edits)
  savedAt?: string;    // ISO timestamp of that save
}

// The authenticated user, as returned by the backend /login and /me endpoints.
// Not from the DB — comes from AD (or the local dev account).
export interface AuthUser {
  username: string;      // sAMAccountName (used as the saved_by key later)
  display_name: string;  // friendly name for the header
  email: string;
  groups: string[];      // AD group DNs the user belongs to
  source: string;        // 'ad' | 'local'
  // App-group permissions resolved by the backend at login. snake_case to match
  // display_name and the backend JSON (no mapper needed).
  perms: { can_edit: boolean; can_manage: boolean };
}

// One badge color-set — used to visually distinguish rows coming from different PPS files.
export interface FileColor {
  hex: string;
  bg: string;
  border: string;
}

// Payload for the toast context in hooks/useToast.tsx.
export interface ToastMsg {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

// Which top-level view is showing (see App.tsx / Header.tsx). 'summary' is public
// to all logged-in users; 'menu'/'log' are admin-only.
export type AppView = 'menu' | 'log' | 'compare' | 'summary';

// Admin Log page payloads (snake_case = straight from the backend JSON).
export interface ActiveUser {
  username: string;
  display_name: string;
  last_seen: string;
  seconds_ago: number;
}
export interface LoginEvent {
  at: string;
  username: string;
  display_name: string;
  source: string;
}
export interface ChangeEvent {
  at: string;
  username: string;
  row_key: string;
  field: string;
  old_value: string;
  new_value: string;
}
