// Single responsibility: decoding baseline and extended sequential Huffman JPEG (SOF0/SOF1) into
// RGBA. Every other coding — progressive, arithmetic, lossless, 12-bit, CMYK — is refused by name
// with a coded error, because a decoder that guesses at one of them emits plausible noise instead.

import { imageDecodeFailed, imageUnsupported } from './errors';
import { type HuffmanTable, JpegBitReader, readHuffmanTables } from './jpeg-huffman';
import { ycbcrToRgb, ZIGZAG } from './jpeg-tables';
import { assertPixelBudget, type Raster, rasterFrom } from './raster';

const BASELINE_FIX = 're-encode to baseline JPEG: `convert in.jpg -interlace none baseline.jpg`';

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

/**
 * AAN's scale factors, folded into the quantisation table at DQT time along with the 1/8 the
 * two-dimensional inverse owes. That is what lets `idct1d` be 11 multiplies per row instead of
 * the 64 a direct evaluation costs, without a single scaling step in the per-block hot path.
 */
const AAN = Float32Array.from([
  1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.5411961, 0.275899379,
]);
const SQRT2 = Math.SQRT2;

/** Reused across every block of every image: the decoder is synchronous and single-threaded. */
const COEF = new Int32Array(64);
const WORK = new Float32Array(64);

interface Component {
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

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly components: readonly Component[];
  readonly maxH: number;
  readonly maxV: number;
  readonly mcusPerLine: number;
  readonly mcusPerColumn: number;
}

/** One component as this scan selects it — resolved once, so no block decode re-checks a table. */
interface ScanComponent {
  readonly comp: Component;
  readonly dc: HuffmanTable;
  readonly ac: HuffmanTable;
}

const readU16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

const hex = (value: number | undefined): string =>
  (value ?? 0).toString(16).toUpperCase().padStart(2, '0');

/** APP14 payload `Adobe` + version + two flag words, then the colour transform at byte 11. */
const ADOBE = [0x41, 0x64, 0x6f, 0x62, 0x65] as const;
const isAdobe = (seg: Uint8Array): boolean =>
  seg.length >= 12 && ADOBE.every((byte, i) => seg[i] === byte);

/** DQT carries any number of tables; 16-bit precision doubles each entry. */
function readQuantTables(seg: Uint8Array, quant: Array<Float32Array | undefined>): void {
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

function readFrame(seg: Uint8Array, marker: number): Frame {
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

/** libjpeg's AAN float butterfly, in place over the 8 samples `step` apart from `base`. */
function idct1d(v: Float32Array, base: number, step: number): void {
  const s0 = v[base] ?? 0;
  const s1 = v[base + step] ?? 0;
  const s2 = v[base + step * 2] ?? 0;
  const s3 = v[base + step * 3] ?? 0;
  const s4 = v[base + step * 4] ?? 0;
  const s5 = v[base + step * 5] ?? 0;
  const s6 = v[base + step * 6] ?? 0;
  const s7 = v[base + step * 7] ?? 0;
  const e10 = s0 + s4;
  const e11 = s0 - s4;
  const e13 = s2 + s6;
  const e12 = (s2 - s6) * SQRT2 - e13;
  const t0 = e10 + e13;
  const t3 = e10 - e13;
  const t1 = e11 + e12;
  const t2 = e11 - e12;
  const z13 = s5 + s3;
  const z10 = s5 - s3;
  const z11 = s1 + s7;
  const z12 = s1 - s7;
  const t7 = z11 + z13;
  const t11 = (z11 - z13) * SQRT2;
  const z5 = (z10 + z12) * 1.847759065;
  const t10 = 1.0823922 * z12 - z5;
  const t12 = -2.61312593 * z10 + z5;
  const t6 = t12 - t7;
  const t5 = t11 - t6;
  const t4 = t10 + t5;
  v[base] = t0 + t7;
  v[base + step * 7] = t0 - t7;
  v[base + step] = t1 + t6;
  v[base + step * 6] = t1 - t6;
  v[base + step * 2] = t2 + t5;
  v[base + step * 5] = t2 - t5;
  v[base + step * 4] = t3 + t4;
  v[base + step * 3] = t3 - t4;
}

/** `Uint8ClampedArray` is the level shift: it rounds and clamps to 0-255 on every store. */
function writeBlock(comp: Component, at: number, flat: boolean): void {
  const { samples, stride } = comp;
  if (flat) {
    const value = (COEF[0] ?? 0) * (comp.dequant[0] ?? 0) + 128;
    for (let r = 0; r < 8; r += 1) samples.fill(value, at + r * stride, at + r * stride + 8);
    return;
  }
  for (let i = 0; i < 64; i += 1) WORK[i] = (COEF[i] ?? 0) * (comp.dequant[i] ?? 0);
  for (let c = 0; c < 8; c += 1) idct1d(WORK, c, 8);
  for (let r = 0; r < 8; r += 1) idct1d(WORK, r * 8, 1);
  for (let r = 0; r < 8; r += 1) {
    const row = at + r * stride;
    for (let c = 0; c < 8; c += 1) samples[row + c] = (WORK[r * 8 + c] ?? 0) + 128;
  }
}

function decodeBlock(reader: JpegBitReader, scan: ScanComponent, row: number, col: number): void {
  const { comp } = scan;
  if (row >= comp.blocksPerColumn || col >= comp.blocksPerLine) {
    throw imageDecodeFailed(`block ${col},${row} falls outside component ${comp.id}`, { row, col });
  }
  COEF.fill(0);
  const size = reader.decode(scan.dc);
  if (size > 15) {
    throw imageDecodeFailed(`a DC coefficient claims ${size} magnitude bits, over the 15 allowed`);
  }
  comp.pred += reader.receiveAndExtend(size);
  COEF[0] = comp.pred;
  let k = 1;
  let last = 0;
  while (k < 64) {
    const rs = reader.decode(scan.ac);
    const bits = rs & 15;
    const run = rs >> 4;
    if (bits === 0) {
      if (run !== 15) break; // 0x00 is end-of-block; 0xF0 is a run of 16 zeros
      k += 16;
      continue;
    }
    k += run;
    if (k > 63) {
      throw imageDecodeFailed(`an AC run overruns block ${col},${row} of component ${comp.id}`, {
        row,
        col,
      });
    }
    COEF[ZIGZAG[k] ?? 0] = reader.receiveAndExtend(bits);
    last = k;
    k += 1;
  }
  writeBlock(comp, row * 8 * comp.stride + col * 8, last === 0);
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

/** Leaves the walk at the next marker, or at the end when the file carries no EOI. */
function skipToMarker(bytes: Uint8Array, from: number): number {
  for (let at = from; at + 1 < bytes.length; at += 1) {
    if ((bytes[at] ?? 0) === 0xff && (bytes[at + 1] ?? 0) !== 0x00) return at;
  }
  return bytes.length;
}

function decodeScan(
  bytes: Uint8Array,
  start: number,
  seg: Uint8Array,
  frame: Frame,
  quant: ReadonlyArray<Float32Array | undefined>,
  dcTables: ReadonlyArray<HuffmanTable | undefined>,
  acTables: ReadonlyArray<HuffmanTable | undefined>,
  restartInterval: number,
): number {
  const count = seg[0] ?? 0;
  if (count < 1 || seg.length < 1 + count * 2 + 3) {
    throw imageDecodeFailed(`the scan header (SOS) declares ${count} components but is too short`);
  }
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
  const reader = new JpegBitReader(bytes, start);
  const single = scan.length === 1 ? scan[0] : undefined;
  // A non-interleaved scan walks the component's own blocks, which for a subsampled component is
  // fewer than its MCU-padded plane holds; an interleaved one walks whole MCUs.
  const perLine =
    single === undefined
      ? frame.mcusPerLine
      : Math.ceil(Math.ceil((frame.width * single.comp.h) / frame.maxH) / 8);
  const perColumn =
    single === undefined
      ? frame.mcusPerColumn
      : Math.ceil(Math.ceil((frame.height * single.comp.v) / frame.maxV) / 8);
  for (let n = 0; n < perLine * perColumn; n += 1) {
    if (restartInterval > 0 && n > 0 && n % restartInterval === 0) {
      if (!reader.restart()) {
        throw imageDecodeFailed(`the scan omits the restart marker due after ${n} units`, { n });
      }
      for (const entry of scan) entry.comp.pred = 0;
    }
    const row = (n / perLine) | 0;
    const col = n % perLine;
    if (single !== undefined) {
      decodeBlock(reader, single, row, col);
      continue;
    }
    for (const entry of scan) {
      for (let v = 0; v < entry.comp.v; v += 1) {
        for (let h = 0; h < entry.comp.h; h += 1) {
          decodeBlock(reader, entry, row * entry.comp.v + v, col * entry.comp.h + h);
        }
      }
    }
  }
  return skipToMarker(bytes, reader.position);
}

/**
 * Sample planes to RGBA, cropped to the declared size: the MCU-padded edge columns and rows exist
 * only so the last block is whole, and a decoder that returns them reports the wrong dimensions.
 * Chroma is upsampled by replication, which is what `h`/`v` below the maxima mean.
 */
function toRaster(frame: Frame, adobeTransform: number): Raster {
  const { width, height, components, maxH, maxV } = frame;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const luma = components[0];
  if (luma === undefined) throw imageDecodeFailed('the frame declares no components');
  const cb = components[1];
  const cr = components[2];
  // Adobe transform 0 over three components means the samples already ARE R, G and B.
  const alreadyRgb = adobeTransform === 0;
  for (let y = 0; y < height; y += 1) {
    const lumaRow = (((y * luma.v) / maxV) | 0) * luma.stride;
    let out = y * width * 4;
    if (cb === undefined || cr === undefined) {
      for (let x = 0; x < width; x += 1) {
        const grey = luma.samples[lumaRow + (((x * luma.h) / maxH) | 0)] ?? 0;
        pixels[out] = grey;
        pixels[out + 1] = grey;
        pixels[out + 2] = grey;
        pixels[out + 3] = 255;
        out += 4;
      }
      continue;
    }
    const cbRow = (((y * cb.v) / maxV) | 0) * cb.stride;
    const crRow = (((y * cr.v) / maxV) | 0) * cr.stride;
    for (let x = 0; x < width; x += 1) {
      const a = luma.samples[lumaRow + (((x * luma.h) / maxH) | 0)] ?? 0;
      const b = cb.samples[cbRow + (((x * cb.h) / maxH) | 0)] ?? 0;
      const c = cr.samples[crRow + (((x * cr.h) / maxH) | 0)] ?? 0;
      if (alreadyRgb) {
        pixels[out] = a;
        pixels[out + 1] = b;
        pixels[out + 2] = c;
      } else {
        const [r, g, blue] = ycbcrToRgb(a, b, c);
        pixels[out] = r;
        pixels[out + 1] = g;
        pixels[out + 2] = blue;
      }
      pixels[out + 3] = 255;
      out += 4;
    }
  }
  return rasterFrom(width, height, pixels);
}

/** JPEG bytes to RGBA. Baseline and extended sequential only; everything else is named and refused. */
export function decodeJpeg(bytes: Uint8Array): Raster {
  if ((bytes[0] ?? 0) !== 0xff || (bytes[1] ?? 0) !== 0xd8) {
    throw imageDecodeFailed('the bytes do not open with a JPEG SOI marker (FF D8)', {
      first: `${hex(bytes[0])} ${hex(bytes[1])}`,
    });
  }
  const quant: Array<Float32Array | undefined> = [];
  const dcTables: Array<HuffmanTable | undefined> = [];
  const acTables: Array<HuffmanTable | undefined> = [];
  let frame: Frame | undefined;
  let restartInterval = 0;
  let adobeTransform = -1;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if ((bytes[offset] ?? 0) !== 0xff) {
      throw imageDecodeFailed(
        `expected a marker at byte ${offset}, found 0x${hex(bytes[offset])}`,
        {
          offset,
        },
      );
    }
    while (bytes[offset + 1] === 0xff) offset += 1; // fill bytes between segments
    const marker = bytes[offset + 1];
    if (marker === undefined) throw imageDecodeFailed('the file ends inside a marker');
    offset += 2;
    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no payload
    const refused = REFUSED_SOF[marker];
    if (refused !== undefined) {
      throw imageUnsupported(`this JPEG is ${refused}, which is not baseline`, BASELINE_FIX, {
        marker: `FF${hex(marker)}`,
      });
    }
    const length = readU16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) {
      throw imageDecodeFailed(
        `segment FF${hex(marker)} declares ${length} bytes but ${bytes.length - offset} remain`,
        { marker: `FF${hex(marker)}`, length },
      );
    }
    const seg = bytes.subarray(offset + 2, offset + length);
    offset += length;
    if (marker === 0xdb) readQuantTables(seg, quant);
    else if (marker === 0xc4) readHuffmanTables(seg, dcTables, acTables);
    else if (marker === 0xc0 || marker === 0xc1) frame = readFrame(seg, marker);
    else if (marker === 0xdd) restartInterval = readU16(seg, 0);
    else if (marker === 0xee && isAdobe(seg)) adobeTransform = seg[11] ?? adobeTransform;
    else if (marker === 0xda) {
      if (frame === undefined) {
        throw imageDecodeFailed('a scan (SOS) arrives before any frame header (SOF)');
      }
      offset = decodeScan(bytes, offset, seg, frame, quant, dcTables, acTables, restartInterval);
    }
  }
  if (frame === undefined) throw imageDecodeFailed('the file carries no frame header (SOF)');
  return toRaster(frame, adobeTransform);
}
