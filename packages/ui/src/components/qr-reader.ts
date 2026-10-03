// TEST-ONLY: an independent QR reader for versions 1-3, byte mode, level M — written from ISO
// 18004's layout, sharing no code with `qr-encode.ts`/`qr-matrix.ts`, so a placement defect in
// the encoder cannot be mirrored here. Never exported from `index.ts`.

/** The eight published level-M format strings (ISO 18004 Table C.1), indexed by mask pattern —
 *  a table, not a BCH computation, so the reader does not share the encoder's arithmetic. */
const LEVEL_M_FORMAT: readonly number[] = [
  0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001,
  0b100000011001110, 0b100111110010111, 0b100101010100000,
];

/** Total and data codewords per version, level M (ISO 18004 Table 9). */
const CODEWORDS: ReadonlyMap<number, { readonly total: number; readonly data: number }> = new Map([
  [1, { total: 26, data: 16 }],
  [2, { total: 44, data: 28 }],
  [3, { total: 70, data: 44 }],
]);

export interface QrReading {
  readonly version: number;
  readonly mask: number;
  readonly codewords: readonly number[];
  readonly text: string;
  /** Every place the symbol departs from the standard's fixed layout, as `what@row,col`. */
  readonly layoutFaults: readonly string[];
}

type Grid = readonly (readonly boolean[])[];

const at = (grid: Grid, row: number, col: number): boolean => grid[row]?.[col] === true;

export function isFunctionModule(size: number, row: number, col: number): boolean {
  const inCorner = (r0: number, c0: number): boolean =>
    row >= r0 && row < r0 + 8 && col >= c0 && col < c0 + 8;
  if (inCorner(0, 0) || inCorner(0, size - 8) || inCorner(size - 8, 0)) return true;
  if (row === 6 || col === 6) return true;
  if (row === 8 && (col <= 8 || col >= size - 8)) return true;
  if (col === 8 && (row <= 8 || row >= size - 8)) return true;
  // Versions 2-3 have exactly one alignment pattern, centred 7 modules in from the far corner.
  if (size > 21 && Math.abs(row - (size - 7)) <= 2 && Math.abs(col - (size - 7)) <= 2) return true;
  return false;
}

function finderFaults(grid: Grid, size: number): string[] {
  const faults: string[] = [];
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const row = r0 + dr;
        const col = c0 + dc;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        const dark = ring <= 1 || ring === 3;
        if (at(grid, row, col) !== dark) faults.push(`finder@${row},${col}`);
      }
    }
  }
  return faults;
}

function fixedFaults(grid: Grid, size: number): string[] {
  const faults = finderFaults(grid, size);
  for (let i = 8; i < size - 8; i++) {
    if (at(grid, 6, i) !== (i % 2 === 0)) faults.push(`timing@6,${i}`);
    if (at(grid, i, 6) !== (i % 2 === 0)) faults.push(`timing@${i},6`);
  }
  if (size > 21) {
    const centre = size - 7;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        if (at(grid, centre + dr, centre + dc) !== dark) {
          faults.push(`alignment@${centre + dr},${centre + dc}`);
        }
      }
    }
  }
  if (!at(grid, size - 8, 8)) faults.push(`dark-module@${size - 8},8`);
  return faults;
}

type Cell = readonly [number, number];

/** The cells of both format copies, bit 14 first; positions straight from ISO 18004 Figure 25. */
export function formatCells(size: number): readonly [readonly Cell[], readonly Cell[]] {
  const first: Cell[] = [];
  for (let col = 0; col <= 8; col++) if (col !== 6) first.push([8, col]);
  for (let row = 7; row >= 0; row--) if (row !== 6) first.push([row, 8]);
  const second: Cell[] = [];
  for (let row = size - 1; row >= size - 7; row--) second.push([row, 8]);
  for (let col = size - 8; col < size; col++) second.push([8, col]);
  return [first, second];
}

function formatCopies(grid: Grid, size: number): readonly [number, number] {
  const read = (cells: readonly Cell[]): number =>
    cells.reduce((acc, [row, col]) => (acc << 1) | (at(grid, row, col) ? 1 : 0), 0);
  const [first, second] = formatCells(size);
  return [read(first), read(second)];
}

function maskFlips(mask: number, row: number, col: number): boolean {
  const formulas: readonly ((i: number, j: number) => boolean)[] = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (_i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
  ];
  return formulas[mask]?.(row, col) === true;
}

function readCodewords(grid: Grid, size: number, mask: number, count: number): number[] {
  const bits: number[] = [];
  // Two-column strips from the right edge; the strip that would straddle the vertical timing
  // column moves one left, so column 6 is never read and column 0 always is.
  const strips: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) strips.push(right > 6 ? right : right - 1);
  strips.forEach((right, index) => {
    const upward = index % 2 === 0;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (isFunctionModule(size, row, col)) continue;
        bits.push(at(grid, row, col) !== maskFlips(mask, row, col) ? 1 : 0);
      }
    }
  });
  const words: number[] = [];
  for (let i = 0; i < count; i++) {
    words.push(bits.slice(i * 8, i * 8 + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  return words;
}

/** Reed-Solomon syndromes over GF(256)/0x11d: all zero exactly when no codeword is corrupt. */
export function syndromesZero(codewords: readonly number[], eccCount: number): boolean {
  const exp: number[] = [];
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp.push(x);
    x = x & 0x80 ? ((x << 1) ^ 0x11d) & 0xff : x << 1;
  }
  const log = new Map<number, number>(exp.map((v, i) => [v, i]));
  const mul = (a: number, b: number): number =>
    a === 0 || b === 0 ? 0 : (exp[((log.get(a) ?? 0) + (log.get(b) ?? 0)) % 255] ?? 0);
  for (let k = 0; k < eccCount; k++) {
    let s = 0;
    for (const word of codewords) s = mul(s, exp[k] ?? 1) ^ word;
    if (s !== 0) return false;
  }
  return true;
}

/** Reads `grid` as a QR symbol. Never throws: a symbol that does not read is `text: ''` plus
 *  whatever faults explain why. */
export function readQr(grid: Grid): QrReading {
  const size = grid.length;
  const version = (size - 17) / 4;
  const faults = fixedFaults(grid, size);
  const [first, second] = formatCopies(grid, size);
  if (first !== second) faults.push('format-copies-differ');
  const mask = LEVEL_M_FORMAT.indexOf(first);
  if (mask < 0) faults.push('format-not-level-m');
  const total = CODEWORDS.get(version)?.total ?? 0;
  const codewords = mask < 0 ? [] : readCodewords(grid, size, mask, total);
  const dataCount = CODEWORDS.get(version)?.data ?? 0;
  if (codewords.length === 0 || !syndromesZero(codewords, total - dataCount)) {
    return { version, mask, codewords, text: '', layoutFaults: [...faults, 'reed-solomon'] };
  }
  const bits = codewords
    .slice(0, dataCount)
    .flatMap((word) => Array.from({ length: 8 }, (_, i) => (word >>> (7 - i)) & 1));
  const field = (start: number, length: number): number =>
    bits.slice(start, start + length).reduce((acc, bit) => (acc << 1) | bit, 0);
  if (field(0, 4) !== 0b0100) return { version, mask, codewords, text: '', layoutFaults: faults };
  const length = field(4, 8);
  const bytes = Uint8Array.from({ length }, (_, i) => field(12 + i * 8, 8));
  return { version, mask, codewords, text: new TextDecoder().decode(bytes), layoutFaults: faults };
}
