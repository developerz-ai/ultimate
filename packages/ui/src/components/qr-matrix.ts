// The placement half of the pure-TypeScript QR encoder: function patterns, data placement,
// masking and format information over the codewords `qr-encode.ts` builds. Versions 1-3 only
// (see that file's header for why): at most one alignment pattern, no version-information
// block, one Reed-Solomon block — the three simplifications that keep this file a page long.

import {
  ALIGNMENT_POSITIONS,
  buildCodewords,
  EC_LEVEL_M_INDICATOR,
  pickVersion,
  sizeForVersion,
} from './qr-encode';

type Module = boolean | undefined;

/** `true`/`false` is a set module (dark/light); `undefined` is not yet claimed by any pattern —
 *  the placement pass below only ever writes into `undefined` cells, so a function pattern drawn
 *  first can never be overwritten by data. */
class Matrix {
  readonly size: number;
  private cells: Module[];

  constructor(size: number) {
    this.size = size;
    this.cells = new Array<Module>(size * size).fill(undefined);
  }

  get(row: number, col: number): Module {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return undefined;
    return this.cells[row * this.size + col];
  }

  set(row: number, col: number, dark: boolean): void {
    this.cells[row * this.size + col] = dark;
  }

  isSet(row: number, col: number): boolean {
    return this.get(row, col) !== undefined;
  }

  toBooleans(): boolean[][] {
    const out: boolean[][] = [];
    for (let r = 0; r < this.size; r++) {
      const row: boolean[] = [];
      for (let c = 0; c < this.size; c++) row.push(this.cells[r * this.size + c] === true);
      out.push(row);
    }
    return out;
  }
}

function drawFinderPattern(matrix: Matrix, centerRow: number, centerCol: number): void {
  for (let dr = -4; dr <= 4; dr++) {
    for (let dc = -4; dc <= 4; dc++) {
      const r = centerRow + dr;
      const c = centerCol + dc;
      if (r < 0 || c < 0 || r >= matrix.size || c >= matrix.size) continue;
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      // Concentric squares: dark core (0-1), light ring (2), dark ring (3), light border (4).
      const dark = dist <= 1 || dist === 3;
      matrix.set(r, c, dark);
    }
  }
}

function drawAlignmentPattern(matrix: Matrix, centerRow: number, centerCol: number): void {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      matrix.set(centerRow + dr, centerCol + dc, dist !== 1);
    }
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  const size = matrix.size;

  // Three finder patterns, each an 8x8 area (7x7 pattern plus a light separator ring); only the
  // 7x7 pattern is drawn as dark/light above, so the surrounding separator is drawn explicitly.
  const corners: readonly (readonly [number, number])[] = [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ];
  for (const [row, col] of corners) drawFinderPattern(matrix, row, col);
  // Separators: the light ring one module beyond each finder pattern, clipped to the matrix.
  for (const [row, col] of corners) {
    for (let d = -4; d <= 4; d++) {
      for (const [r, c] of [
        [row + d, col - 5],
        [row + d, col + 5],
        [row - 5, col + d],
        [row + 5, col + d],
      ] as const) {
        if (r >= 0 && c >= 0 && r < size && c < size && !matrix.isSet(r, c))
          matrix.set(r, c, false);
      }
    }
  }

  // Timing patterns: row 6 and column 6, alternating dark/light, skipping cells the finder
  // patterns already claimed.
  for (let i = 0; i < size; i++) {
    const dark = i % 2 === 0;
    if (!matrix.isSet(6, i)) matrix.set(6, i, dark);
    if (!matrix.isSet(i, 6)) matrix.set(i, 6, dark);
  }

  // Alignment pattern(s): every (row, col) pair from this version's coordinate list, except the
  // one that overlaps the top-left finder pattern.
  const positions = ALIGNMENT_POSITIONS[version - 1] ?? [];
  for (const row of positions) {
    for (const col of positions) {
      if (row === 6 && col === 6) continue;
      drawAlignmentPattern(matrix, row, col);
    }
  }

  // The single dark module every version carries at a fixed offset from the bottom-left finder
  // pattern — part of the format-information area, not itself format data.
  matrix.set(4 * version + 9, 8, true);

  // Reserve (as light, for now) the format-information cells around the top-left finder pattern
  // and the two strips mirroring it — `drawFormatInfo` overwrites the ones that carry a 1 bit.
  for (let i = 0; i < 8; i++) {
    if (!matrix.isSet(8, i)) matrix.set(8, i, false);
    if (!matrix.isSet(i, 8)) matrix.set(i, 8, false);
    if (!matrix.isSet(8, size - 1 - i)) matrix.set(8, size - 1 - i, false);
    if (!matrix.isSet(size - 1 - i, 8)) matrix.set(size - 1 - i, 8, false);
  }
  if (!matrix.isSet(8, 8)) matrix.set(8, 8, false);
}

/** BCH(15,5) error-correction over the 5-bit format-info value (2-bit EC level + 3-bit mask
 *  pattern), XORed with the fixed mask 0b101010000010010 — the exact construction ISO 18004
 *  §8.9 specifies for the 15-bit format string every QR symbol below version 7 carries twice. */
export function formatInfoBits(maskPattern: number): number {
  const GENERATOR = 0b10100110111;
  const data = (EC_LEVEL_M_INDICATOR << 3) | maskPattern;
  let value = data << 10;
  for (let shift = 4; shift >= 0; shift--) {
    if ((value & (1 << (shift + 10))) !== 0) value ^= GENERATOR << shift;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function drawFormatInfo(matrix: Matrix, maskPattern: number): void {
  const size = matrix.size;
  const bits = formatInfoBits(maskPattern);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;

  // The top-left strip: bits 0-5 down column 8 (skipping the timing row), bits 6-7 continue
  // down the same column past row 7, bits 8-14 continue along row 8 to the right of column 8
  // (skipping the timing column) — the standard's own zig from the corner.
  for (let i = 0; i <= 5; i++) matrix.set(i, 8, bit(i));
  matrix.set(7, 8, bit(6));
  matrix.set(8, 8, bit(7));
  matrix.set(8, 7, bit(8));
  for (let i = 9; i <= 14; i++) matrix.set(8, 14 - i, bit(i));

  // The mirrored copy: bits 0-7 along row `size-1` down to `size-8` in column 8, bits 8-14 up
  // column `size-1` down to `size-15` in row 8.
  for (let i = 0; i <= 7; i++) matrix.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i <= 14; i++) matrix.set(8, size - 15 + i, bit(i));
}

/** Whether mask `pattern` (0-7, ISO 18004 §8.8.1) flips the module at `(row, col)`. */
export function applyMask(row: number, col: number, pattern: number): boolean {
  switch (pattern) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** Writes `codewords` into every module the function patterns left `undefined`, in the standard
 *  boustrophedon (up-down, right-to-left in 2-column strides, skipping the timing column) order,
 *  masking each written bit with `pattern` as it goes — masking happens INLINE here rather than
 *  as a second pass, because only the data modules (never a function pattern) are ever masked. */
function drawData(matrix: Matrix, codewords: readonly number[], pattern: number): void {
  const size = matrix.size;
  const bits: boolean[] = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push(((byte >>> i) & 1) === 1);

  let bitIndex = 0;
  let upward = true;
  for (let colPair = size - 1; colPair > 0; colPair -= 2) {
    for (let count = 0; count < size; count++) {
      const row = upward ? size - 1 - count : count;
      for (let colOffset = 0; colOffset < 2; colOffset++) {
        const col = colPair - colOffset;
        if (col === 6) continue; // the vertical timing column carries no data
        if (matrix.isSet(row, col)) continue;
        const bit = bits[bitIndex] ?? false;
        bitIndex++;
        const masked = applyMask(row, col, pattern) ? !bit : bit;
        matrix.set(row, col, masked);
      }
    }
    upward = !upward;
  }
}

/** N1: five or more same-colour modules in a row/column. */
function runPenalty(line: readonly boolean[]): number {
  let total = 0;
  let runLength = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      runLength++;
      continue;
    }
    if (runLength >= 5) total += 3 + (runLength - 5);
    runLength = 1;
  }
  return total;
}

/** N3: the finder-like dark-light-dark-dark-dark-light-dark run, with 4 light either side. */
const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_LIKE_REVERSED = [...FINDER_LIKE].reverse();

function finderLikePenalty(line: readonly boolean[]): number {
  let total = 0;
  const matches = (start: number, target: readonly boolean[]): boolean =>
    target.every((v, i) => line[start + i] === v);
  for (let i = 0; i + FINDER_LIKE.length <= line.length; i++) {
    if (matches(i, FINDER_LIKE) || matches(i, FINDER_LIKE_REVERSED)) total += 40;
  }
  return total;
}

/** The standard penalty score (ISO 18004 §8.8.2, rules N1-N4) — lower is a better mask, chosen
 *  by trying all 8 candidates rather than fixing one, so this encoder's output is a symbol a
 *  real scanner reads reliably rather than merely a structurally valid one. */
export function maskPenalty(bools: readonly (readonly boolean[])[]): number {
  const size = bools.length;
  const column = (c: number): boolean[] => bools.map((row) => row[c] === true);
  let penalty = 0;

  for (const row of bools) penalty += runPenalty(row) + finderLikePenalty(row);
  for (let c = 0; c < size; c++) {
    const col = column(c);
    penalty += runPenalty(col) + finderLikePenalty(col);
  }

  // N2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = bools[r]?.[c] ?? false;
      if (bools[r]?.[c + 1] === v && bools[r + 1]?.[c] === v && bools[r + 1]?.[c + 1] === v) {
        penalty += 3;
      }
    }
  }

  // N4: overall dark-module proportion, penalised the further it strays from 50%.
  const dark = bools.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const percentDark = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percentDark - 50) / 5) * 10;

  return penalty;
}

/** Light modules on every side of the symbol. Four is the standard's minimum; fewer and a
 *  scanner cannot separate the finder patterns from whatever the page drew next to them. */
export const DEFAULT_QUIET_ZONE = 4;

/** The quiet zone a caller asked for, screened: a non-integer, a negative or `NaN` would move
 *  every module by a nonsense offset, so anything but a whole count of modules is the default. */
export function quietZoneOf(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 0) {
    return DEFAULT_QUIET_ZONE;
  }
  return requested;
}

export interface QrMatrix {
  /** Modules per side — 21, 25 or 29 for versions 1, 2 and 3. */
  readonly size: number;
  /** `modules[row][col]` — `true` is a dark (foreground) module. */
  readonly modules: readonly (readonly boolean[])[];
  readonly version: number;
}

interface MaskCandidate {
  readonly pattern: number;
  readonly bools: boolean[][];
  readonly penalty: number;
}

/**
 * Encodes `text` as a QR symbol, byte mode, error-correction level M, choosing the smallest of
 * versions 1-3 that fits. Throws `X_UI_QR_CAPACITY` past version 3's 42-byte ceiling. Pure: the
 * same text always yields the same modules, so a server render and a hydrated one agree.
 */
export function encodeQr(text: string): QrMatrix {
  const payload = new TextEncoder().encode(text);
  const version = pickVersion(payload.length);
  const codewords = buildCodewords(payload, version);
  const size = sizeForVersion(version);

  let best: MaskCandidate | undefined;
  for (let pattern = 0; pattern < 8; pattern++) {
    const matrix = new Matrix(size);
    drawFunctionPatterns(matrix, version);
    drawData(matrix, codewords, pattern);
    drawFormatInfo(matrix, pattern);
    const bools = matrix.toBooleans();
    const penalty = maskPenalty(bools);
    if (best === undefined || penalty < best.penalty) best = { pattern, bools, penalty };
  }
  // `pickVersion` already threw if nothing fits, so by construction all eight masks ran; the
  // fallback is unreachable and exists so the return type needs no assertion.
  return { size, modules: best?.bools ?? [], version };
}
