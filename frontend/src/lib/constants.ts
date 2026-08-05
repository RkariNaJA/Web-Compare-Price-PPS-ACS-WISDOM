/**
 * Fixed configuration for the validator: column mappings, size dictionaries,
 * PPS-file limits, and the badge colour palette. These are single-source-of-truth
 * — any rename or new alias goes here, not scattered across components.
 */
import type { FileColor, KeyPair } from './types';

// Maximum number of PPS files a user can drop at once.
export const MAX_B_FILES = 4;

// Row badge palette — one entry per PPS file. Cycles if you allow more than 4 later.
// Muted naturals (Ma palette) — mid-tones chosen to read on both washi (light)
// and sumi (dark) grounds, since these are fixed hex values, not theme tokens.
export const FILE_COLORS: FileColor[] = [
  { hex: '#6b7385', bg: 'rgba(94,102,120,.14)', border: 'rgba(94,102,120,.42)' },   // ai-nezumi indigo
  { hex: '#a5817a', bg: 'rgba(165,129,122,.14)', border: 'rgba(165,129,122,.42)' }, // toki clay
  { hex: '#79866a', bg: 'rgba(121,134,106,.14)', border: 'rgba(121,134,106,.42)' }, // rikyū sage
  { hex: '#a98c4e', bg: 'rgba(169,140,78,.14)', border: 'rgba(169,140,78,.42)' },   // kihada ochre
];

// The 5 key columns that link an ACS row to a PPS row. `a` is the ACS header,
// `b` is the equivalent PPS header. Order matters for display in the results table.
export const KEY_PAIRS: KeyPair[] = [
  { a: 'Season', b: 'SEASON_YEAR' },
  { a: 'EXTRACTED_SIZE', b: 'SIZE_DATA' },
  { a: 'StyleNumber', b: 'STYLE' },
  { a: 'ColorwayCode', b: 'COLOR' },
  { a: 'FactoryCode', b: 'FTYCODE' },
];

// Keys used to BUILD the ACS index (size is handled separately via matchDbRowForSize).
export const JOIN_KEY_PAIRS = KEY_PAIRS.filter((kp) => kp.a !== 'EXTRACTED_SIZE');

// Preferred Costsheet header names. These are what the app "wants" to see;
// actual matching is alias-tolerant (see C_KEY_ALIASES).
export const C_KEY_MAP = {
  season: 'Season',
  style: 'Style No.',
  color: 'Color',
  factory: 'Factory',
  size: 'Size',
  fob: 'Final FOB',                // MAX First Input Date wins; this is the value we compare against
  extFob: 'Extended Size FOB',     // used INSTEAD of `fob` when the Costsheet row is an extended size
  date: 'First Input Date',
  version: 'CBD Version',          // shown as "Version" in the results table
  costSheetNo: 'Cost Sheet No.',   // shown as "Cost Sheet No" in the results table
} as const;

// Alternative header spellings the Costsheet view might use. Normalization drops
// whitespace/underscores/dots/hyphens and lowercases before comparing.
// Add here whenever a new view rename shows up.
export const C_KEY_ALIASES: Record<keyof typeof C_KEY_MAP, string[]> = {
  season: ['season', 'seasonyear', 'seasoncode'],
  style: ['styleno', 'stylenumber', 'style', 'style#'],
  color: ['color', 'colour', 'colorway', 'colorwaycode'],
  factory: ['factory', 'factorycode', 'fty', 'ftycode'],
  size: ['size', 'sizedata', 'sizecode'],
  fob: ['finalfob', 'finalfobprice', 'finalfobamount'],
  extFob: ['extendedsizefob', 'extsizefob', 'extendsizefob'],
  date: ['firstinputdate', 'inputdate', 'firstinput'],
  version: ['cbdversion', 'version'],
  costSheetNo: ['costsheetno', 'costsheetnumber', 'costsheet#'],
};

// Currency the validator compares in. PPS quotes in any other currency are kept but not
// compared, because the ACS and Costsheet FOBs are all in this currency. Promote to a
// user-facing setting when real multi-currency support arrives.
export const PREFERRED_CURRENCY = 'USD';

// When loading a PPS file, keep ONLY these columns. Everything else is dropped
// so the comparison focuses on what matters and the preview stays readable.
// MSC_CODE / RESPONSIBLE_DEVELOPER are kept for display in the results table
// (they come straight from the uploaded PPS "File Compare", not from ACS/Costsheet).
export const STRICT_B_COLS = [
  'MSC_CODE',
  'RESPONSIBLE_DEVELOPER',
  'SEASON_YEAR',
  'STYLE',
  'COLOR',
  'FTYCODE',
  'SIZE_DATA',
  'LOCAL_QUOTE_AMOUNT',
  'LOCAL_CURRENCY',   // tells a currency twin from a genuinely different quote
  'INSERT_DATE',      // makes dedupePPSRows' newest-wins tie-break actually run
];

// Regular sizes — any of these get folded into the bucket "ALL_REG_SIZE_RB" during normalization.
// This lets a PPS row with an empty SIZE_DATA (which becomes ALL_REG_SIZE_RB) match a Costsheet
// row that has e.g. size "S".
export const REG_SIZES = [
  '0X', '1X', '2X', '3X', '4X', '2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL',
  'L/XL', 'S/M', 'S+', 'M+', 'L+', 'XL+', '1SIZE',
  '3-6', '6-9', '9-12', '12-18', '18-24', '40', '44', '48', '52', '56',
  '34R', '36R', '36+1', '36+2', '38R', '38+1', '38+2',
  '40R', '40+1', '40+2', '42R', '42+1', '42+2',
  '44R', '44+1', '44+2', '46R', '46+1', '46+2',
  '34-1', '36-1', '38-1', '40-1', '42-1', '44-1', '46-1',
  '44/4', '46/4', '48/4', '50/4', '52/4', '54/4', '56/4',
  '44/6', '46/4', '48/6', '50/6', '52/6', '54/6', '56/6', '58/6',
];

// Extended sizes — same idea but they fold into "ALL_EXTEND_SIZE_RB" instead.
// Extend sizes are kept separate from REG so tall/big-and-tall SKUs don't spuriously match regular.
export const EXTEND_SIZE = [
  '4X', '1X-T', '2X-T', '3X-T', '3XL', '4XL', '5XL',
  'S-T', 'M-T', 'L-T', 'L-TT', 'XL-T', '2XL-T', '3XL-T',
  '4XL-T', '5XL-T', 'MTT', 'LTT', 'XLTT', 'XL-TT',
  '2XLTT', '3XLTT', 'CUST1', 'CUST3', '48', '58', '60',
  '48R', '48+1', '48+2', '48-1',
];
