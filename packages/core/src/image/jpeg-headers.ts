// Single responsibility: what a JPEG's descriptive segments DECLARE, and what they are refused for
// declaring — the DQT tables, the SOF geometry, the SOS component selection, and every coding
// flavour this decoder names rather than guesses at. No entropy decoding and no pixels: that half
// is `jpeg-decode.ts`, and keeping the two apart is what keeps either inside one file's worth of job.

import { imageDecodeFailed, imageUnsupported } from './errors';
import type { HuffmanTable } from './jpeg-huffman';
import { AAN_SCALE, ZIGZAG } from './jpeg-tables';
import { assertPixelBudget } from './raster';

export const BASELINE_FIX =
  're-encode to baseline JPEG: `convert in.jpg -interlace none baseline.jpg`';

export const readU16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

export const hex = (value: number | undefined): string =>
  (value ?? 0).toString(16).toUpperCase().padStart(2, '0');

/** Every SOF flavour this decoder refuses, named the way a re-encoding tool names it. */
const REFUSED_SOF: Readonly<Record<number, string>> = {
  194: 'SOF2 progressive DCT',
  195: 'SOF3 lossless',
  197: 'SOF5 differential sequential DCT',
  198: 'SOF6 differential progressive DCT',
  199: 'SOF7 differential lossless',
  201: 'SOF9 extended sequential DCT, arithmetic coding',
  202: 'SOF10 progressive DCT, arithmetic coding',
  203: 'SOF11 lossless, arithmetic coding',
  204: 'DAC arithmetic coding conditioning',
  205: 'SOF13 differential sequential DCT, arithmetic coding',
  206: 'SOF14 differential progressive DCT, arithmetic coding',
  207: 'SOF15 differential lossless, arithmetic coding',
};

/** Refused at the marker, before a single coefficient is read: the name is the whole point. */
export function assertSupportedCoding(marker: number): void {
  const refused = REFUSED_SOF[marker];
  if (refused === undefined) return;
  throw imageUnsupported(`this JPEG is ${refused}, which is not baseline`, BASELINE_FIX, {
    marker: `FF${hex(marker)}`,
  });
}

/** APP14 payload `Adobe` + version + two flag words, then the colour transform at byte 11. */
const ADOBE = [0x41, 0x64, 0x6f, 0x62, 0x65] as const;
export const isAdobe = (seg: Uint8Array): boolean =>
  seg.length >= 12 && ADOBE.every((byte, i) => seg[i] === byte);

export interface Component {
  readonly id: number;
  readonly h: number;
  readonly v: number;
  readonly quantId: number;
  /** MCU-padded sample plane; `stride` exceeds the image width whenever `h < maxH`. */
  readonly samples: Uint8ClampedArray;
  readonly stride: number;
  readonly blocksPerLine: number;
  readonly blocksPerColumn: number;
  dequant: Float32Array;
  /** The running DC predictor, reset at every restart interval and at every scan. */
  pred: number;
}

export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly components: readonly Component[];
  readonly maxH: number;
  readonly maxV: number;
  readonly mcusPerLine: number;
  readonly mcusPerColumn: number;
}

/** One component as this scan selects it — resolved once, so no block decode re-checks a table. */
export interface ScanComponent {
  readonly comp: Component;
  readonly dc: HuffmanTable;
  readonly ac: HuffmanTable;
}

/**
 * The shared AAN scale factors, folded into the quantisation table at DQT time along with the 1/8
 * the two-dimensional inverse owes. That is what lets `idct1d` be 11 multiplies per row instead of
 * the 64 a direct evaluation costs, without a single scaling step in the per-block hot path.
 * `Float32Array` because every value it multiplies is float32 — the widths must match, not the
 * numbers only.
 */
const AAN = Float32Array.from(AAN_SCALE);

/** DQT carries any number of tables; 16-bit precision doubles each entry. */
export function readQuantTables(seg: Uint8Array, quant: Array<Float32Array | undefined>): void {
  let at = 0;
  while (at < seg.length) {
    const spec = seg[at] ?? 0;
    at += 1;
    const precision = spec >> 4;
    const id = spec & 15;
    if (precision > 1 || id > 3) {
      throw imageDecodeFailed(`DQT declares table ${id} with precision code ${precision}`, {
        id,
        precision,
      });
    }
    const size = precision === 1 ? 2 : 1;
    if (at + 64 * size > seg.length) {
      throw imageDecodeFailed(`DQT table ${id} is truncated: it needs ${64 * size} more bytes`, {
        id,
      });
    }
    const table = new Float32Array(64);
    for (let k = 0; k < 64; k += 1) {
      const value = size === 2 ? readU16(seg, at) : (seg[at] ?? 0);
      at += size;
      const natural = ZIGZAG[k] ?? 0;
      table[natural] = value * (AAN[natural >> 3] ?? 1) * (AAN[natural & 7] ?? 1) * 0.125;
    }
    quant[id] = table;
  }
}

export function readFrame(seg: Uint8Array, marker: number): Frame {
  if (seg.length < 6) throw imageDecodeFailed('the frame header (SOF) is shorter than its fields');
  const precision = seg[0] ?? 0;
  if (precision !== 8) {
    throw imageUnsupported(
      `this JPEG codes ${precision}-bit samples; only 8-bit precision is decoded`,
      BASELINE_FIX,
      { precision, marker: `FF${hex(marker)}` },
    );
  }
  const height = readU16(seg, 1);
  const width = readU16(seg, 3);
  assertPixelBudget(width, height, 'jpeg');
  const count = seg[5] ?? 0;
  if (count !== 1 && count !== 3) {
    const model = count === 4 ? 'CMYK or YCCK' : 'an unknown colour model';
    throw imageUnsupported(
      `this JPEG has ${count} components (${model}); only 1-component greyscale and ` +
        '3-component YCbCr are decoded',
      BASELINE_FIX,
      { components: count },
    );
  }
  if (seg.length < 6 + count * 3) {
    throw imageDecodeFailed(`the frame header ends before its ${count} component descriptors`);
  }
  const specs: Array<readonly [number, number, number, number]> = [];
  let maxH = 1;
  let maxV = 1;
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 3;
    const sampling = seg[at + 1] ?? 0;
    const h = sampling >> 4;
    const v = sampling & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) {
      throw imageDecodeFailed(`component ${i} declares ${h}x${v} sampling factors, outside 1-4`, {
        h,
        v,
      });
    }
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
    specs.push([seg[at] ?? 0, h, v, seg[at + 2] ?? 0]);
  }
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const components = specs.map(([id, h, v, quantId]) => {
    const blocksPerLine = mcusPerLine * h;
    const blocksPerColumn = mcusPerColumn * v;
    const stride = blocksPerLine * 8;
    return {
      id,
      h,
      v,
      quantId,
      samples: new Uint8ClampedArray(stride * blocksPerColumn * 8),
      stride,
      blocksPerLine,
      blocksPerColumn,
      dequant: new Float32Array(64),
      pred: 0,
    };
  });
  return { width, height, components, maxH, maxV, mcusPerLine, mcusPerColumn };
}

const pickTable = (
  tables: ReadonlyArray<HuffmanTable | undefined>,
  id: number,
  kind: string,
  component: number,
): HuffmanTable => {
  const table = tables[id];
  if (table === undefined) {
    throw imageDecodeFailed(
      `component ${component} selects ${kind} Huffman table ${id}, which no DHT segment defined`,
      { component, kind, table: id },
    );
  }
  return table;
};

/**
 * The last three SOS bytes, which a sequential scan is only allowed one value of: the whole band
 * (Ss=0, Se=63) at full precision (Ah=Al=0). Anything else is a progressive scan's shape wearing a
 * baseline frame header — `decodeBlock` would read its coefficients as complete ones and emit a
 * plausible, wrong image, which is exactly what this decoder refuses to do.
 */
function assertWholeBand(seg: Uint8Array, count: number): void {
  const ss = seg[1 + count * 2] ?? 0;
  const se = seg[2 + count * 2] ?? 0;
  const approx = seg[3 + count * 2] ?? 0;
  const ah = approx >> 4;
  const al = approx & 15;
  if (ss === 0 && se === 63 && ah === 0 && al === 0) return;
  throw imageUnsupported(
    `this JPEG's scan codes coefficients ${ss}-${se} at successive approximation ${ah}/${al}; a ` +
      'sequential scan must carry the whole 0-63 band at 0/0',
    BASELINE_FIX,
    { ss, se, ah, al },
  );
}

/**
 * SOS: the components this scan codes, bound to the tables each one selects. Resolving them once,
 * here, is what leaves the per-block hot path with no lookups and no validation of its own.
 */
export function readScanHeader(
  seg: Uint8Array,
  frame: Frame,
  quant: ReadonlyArray<Float32Array | undefined>,
  dcTables: ReadonlyArray<HuffmanTable | undefined>,
  acTables: ReadonlyArray<HuffmanTable | undefined>,
): ScanComponent[] {
  const count = seg[0] ?? 0;
  if (count < 1 || seg.length < 1 + count * 2 + 3) {
    throw imageDecodeFailed(`the scan header (SOS) declares ${count} components but is too short`);
  }
  assertWholeBand(seg, count);
  const scan: ScanComponent[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = seg[1 + i * 2] ?? 0;
    const selector = seg[2 + i * 2] ?? 0;
    const comp = frame.components.find((candidate) => candidate.id === id);
    if (comp === undefined) {
      throw imageDecodeFailed(`the scan names component ${id}, which the frame never declared`, {
        component: id,
      });
    }
    const table = quant[comp.quantId];
    if (table === undefined) {
      throw imageDecodeFailed(
        `component ${id} selects quantisation table ${comp.quantId}, which no DQT segment defined`,
        { component: id, table: comp.quantId },
      );
    }
    comp.dequant = table;
    comp.pred = 0;
    scan.push({
      comp,
      dc: pickTable(dcTables, selector >> 4, 'DC', id),
      ac: pickTable(acTables, selector & 15, 'AC', id),
    });
  }
  return scan;
}
