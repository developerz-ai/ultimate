// Single responsibility: writing a raster as a baseline sequential JPEG — SOF0, Huffman-coded,
// 4:2:0, Annex K tables. The subsampling is the whole reason to emit a JPEG instead of a PNG:
// two of the three planes shrink 4x on data the eye cannot resolve, and PNG can never give
// that back. Reads `jpeg-tables.ts` so the encoder and the decoder cannot drift apart.

import {
  AAN_SCALE,
  DEFAULT_JPEG_QUALITY,
  rgbToYcbcr,
  STD_AC_CHROMINANCE_BITS,
  STD_AC_CHROMINANCE_VALUES,
  STD_AC_LUMINANCE_BITS,
  STD_AC_LUMINANCE_VALUES,
  STD_CHROMINANCE_QUANT,
  STD_DC_CHROMINANCE_BITS,
  STD_DC_CHROMINANCE_VALUES,
  STD_DC_LUMINANCE_BITS,
  STD_DC_LUMINANCE_VALUES,
  STD_LUMINANCE_QUANT,
  scaleQuantTable,
  ZIGZAG,
} from './jpeg-tables';
import type { Raster } from './raster';

const MARKER = {
  soi: 0xd8,
  eoi: 0xd9,
  sof0: 0xc0,
  dht: 0xc4,
  sos: 0xda,
  dqt: 0xdb,
  app0: 0xe0,
} as const;

/** A 4:2:0 MCU is 16x16 source pixels: four luma blocks over one Cb and one Cr block. */
const MCU_SIZE = 16;

/**
 * The standard tables have no symbol for an 11-bit AC magnitude or a 12-bit DC difference, so a
 * coefficient past this is unencodable rather than merely unusual — reachable only by a
 * synthetic ±128 checkerboard at quality 100. libjpeg fails the encode there; costing one unit
 * on that block keeps every stream we emit decodable.
 */
const MAX_COEFFICIENT = 1023;

/** Symbol -> code, the mirror of the decoder's MINCODE/MAXCODE form in `jpeg-huffman.ts`. */
interface HuffmanEncoder {
  readonly codes: Int32Array;
  readonly lengths: Int32Array;
}

/** T.81 Annex C: codes are assigned shortest-first, in ascending order within each length. */
function buildEncoder(bits: readonly number[], values: readonly number[]): HuffmanEncoder {
  const codes = new Int32Array(256);
  const lengths = new Int32Array(256);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let n = bits[length - 1] ?? 0; n > 0; n -= 1) {
      const symbol = values[k] ?? 0;
      codes[symbol] = code;
      lengths[symbol] = length;
      code += 1;
      k += 1;
    }
    code <<= 1;
  }
  return { codes, lengths };
}

const DC_LUMA = buildEncoder(STD_DC_LUMINANCE_BITS, STD_DC_LUMINANCE_VALUES);
const AC_LUMA = buildEncoder(STD_AC_LUMINANCE_BITS, STD_AC_LUMINANCE_VALUES);
const DC_CHROMA = buildEncoder(STD_DC_CHROMINANCE_BITS, STD_DC_CHROMINANCE_VALUES);
const AC_CHROMA = buildEncoder(STD_AC_CHROMINANCE_BITS, STD_AC_CHROMINANCE_VALUES);

const C4 = Math.SQRT1_2;
const C6 = 0.382683433;
const C2_SUB_C6 = 0.5411961;
const C2_ADD_C6 = 1.306562965;

/** Folds AAN's leftover scaling into the quantiser, so quantising stays one multiply. */
function buildDivisors(quant: Uint8Array): Float64Array {
  const divisors = new Float64Array(64);
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const i = row * 8 + col;
      divisors[i] = 1 / ((quant[i] ?? 1) * (AAN_SCALE[row] ?? 1) * (AAN_SCALE[col] ?? 1) * 8);
    }
  }
  return divisors;
}

/**
 * One strided 8-point AAN butterfly (Arai/Agui/Nakajima): 5 multiplies instead of the 64 a
 * literal cosine sum costs, and rows and columns share it by varying `step`.
 */
function fdct1d(data: Float64Array, base: number, step: number): void {
  const s0 = data[base] ?? 0;
  const s1 = data[base + step] ?? 0;
  const s2 = data[base + step * 2] ?? 0;
  const s3 = data[base + step * 3] ?? 0;
  const s4 = data[base + step * 4] ?? 0;
  const s5 = data[base + step * 5] ?? 0;
  const s6 = data[base + step * 6] ?? 0;
  const s7 = data[base + step * 7] ?? 0;

  const t0 = s0 + s7;
  const t7 = s0 - s7;
  const t1 = s1 + s6;
  const t6 = s1 - s6;
  const t2 = s2 + s5;
  const t5 = s2 - s5;
  const t3 = s3 + s4;
  const t4 = s3 - s4;

  const e0 = t0 + t3;
  const e3 = t0 - t3;
  const e1 = t1 + t2;
  const e2 = t1 - t2;
  const z1 = (e2 + e3) * C4;
  data[base] = e0 + e1;
  data[base + step * 4] = e0 - e1;
  data[base + step * 2] = e3 + z1;
  data[base + step * 6] = e3 - z1;

  const o0 = t4 + t5;
  const o1 = t5 + t6;
  const o2 = t6 + t7;
  const z5 = (o0 - o2) * C6;
  const z2 = C2_SUB_C6 * o0 + z5;
  const z4 = C2_ADD_C6 * o2 + z5;
  const z3 = o1 * C4;
  data[base + step * 5] = t7 - z3 + z2;
  data[base + step * 3] = t7 - z3 - z2;
  data[base + step] = t7 + z3 + z4;
  data[base + step * 7] = t7 + z3 - z4;
}

function forwardDct(data: Float64Array): void {
  for (let row = 0; row < 8; row += 1) fdct1d(data, row * 8, 1);
  for (let col = 0; col < 8; col += 1) fdct1d(data, col, 8);
}

class JpegSink {
  private buffer: Uint8Array;
  private length = 0;
  private bits = 0;
  private bitCount = 0;

  constructor(capacity: number) {
    this.buffer = new Uint8Array(Math.max(1024, capacity));
  }

  byte(value: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length] = value;
    this.length += 1;
  }

  bytes(values: readonly number[]): void {
    for (const value of values) this.byte(value);
  }

  word(value: number): void {
    this.byte((value >> 8) & 0xff);
    this.byte(value & 0xff);
  }

  marker(code: number): void {
    this.byte(0xff);
    this.byte(code);
  }

  /** A raw 0xFF in the scan would read as a marker, so T.81 stuffs a 0x00 behind every one. */
  writeBits(code: number, length: number): void {
    this.bits = (this.bits << length) | (code & ((1 << length) - 1));
    this.bitCount += length;
    while (this.bitCount >= 8) {
      this.bitCount -= 8;
      const value = (this.bits >>> this.bitCount) & 0xff;
      this.byte(value);
      if (value === 0xff) this.byte(0x00);
    }
    this.bits &= (1 << this.bitCount) - 1;
  }

  /** Pad with 1-bits: a 0-pad can spell a real Huffman code and grow the last block a symbol. */
  flushBits(): void {
    if (this.bitCount > 0) this.writeBits(0xff, 8 - this.bitCount);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

type Plane = Uint8ClampedArray | Float32Array;

interface Planes {
  readonly luma: Uint8ClampedArray;
  readonly cb: Float32Array;
  readonly cr: Float32Array;
  readonly lumaWidth: number;
  readonly chromaWidth: number;
}

/**
 * JPEG carries no alpha, so a transparent pixel still has to become some colour. Compositing
 * over opaque white (`out = src*a + 255*(1-a)`) is why a transparent logo arrives white-backed
 * instead of as the black box that dropping the alpha channel outright would produce.
 * Padding replicates the last real row/column: zero-fill would put a hard step to black inside
 * the edge MCU, and the DCT spreads that step back across visible pixels as a dark rim.
 */
function buildPlanes(raster: Raster, mcusX: number, mcusY: number): Planes {
  const { width, height, pixels } = raster;
  const lumaWidth = mcusX * MCU_SIZE;
  const lumaHeight = mcusY * MCU_SIZE;
  const chromaWidth = mcusX * 8;
  const luma = new Uint8ClampedArray(lumaWidth * lumaHeight);
  const cb = new Float32Array(chromaWidth * mcusY * 8);
  const cr = new Float32Array(chromaWidth * mcusY * 8);
  for (let y = 0; y < lumaHeight; y += 1) {
    const sourceRow = (y < height ? y : height - 1) * width;
    const chromaRow = (y >> 1) * chromaWidth;
    const lumaRow = y * lumaWidth;
    for (let x = 0; x < lumaWidth; x += 1) {
      const p = (sourceRow + (x < width ? x : width - 1)) * 4;
      const alpha = (pixels[p + 3] ?? 255) / 255;
      const over = 255 * (1 - alpha);
      const [yy, cbValue, crValue] = rgbToYcbcr(
        (pixels[p] ?? 0) * alpha + over,
        (pixels[p + 1] ?? 0) * alpha + over,
        (pixels[p + 2] ?? 0) * alpha + over,
      );
      luma[lumaRow + x] = yy;
      const ci = chromaRow + (x >> 1);
      cb[ci] = (cb[ci] ?? 0) + cbValue;
      cr[ci] = (cr[ci] ?? 0) + crValue;
    }
  }
  // Box-average, not point-sample: every chroma sample sees all four pixels it stands in for.
  for (let i = 0; i < cb.length; i += 1) {
    cb[i] = (cb[i] ?? 0) / 4;
    cr[i] = (cr[i] ?? 0) / 4;
  }
  return { luma, cb, cr, lumaWidth, chromaWidth };
}

/** Copies an 8x8 block out of a plane, level-shifted to the DCT's signed range. */
function extractBlock(
  plane: Plane,
  planeWidth: number,
  blockX: number,
  blockY: number,
  out: Float64Array,
): void {
  for (let row = 0; row < 8; row += 1) {
    const source = (blockY * 8 + row) * planeWidth + blockX * 8;
    for (let col = 0; col < 8; col += 1) {
      out[row * 8 + col] = (plane[source + col] ?? 0) - 128;
    }
  }
}

function quantise(block: Float64Array, divisors: Float64Array, out: Int32Array): void {
  for (let i = 0; i < 64; i += 1) {
    const value = Math.round((block[i] ?? 0) * (divisors[i] ?? 0));
    out[i] = Math.max(-MAX_COEFFICIENT, Math.min(MAX_COEFFICIENT, value));
  }
}

function magnitude(value: number): number {
  let bits = 0;
  let rest = value < 0 ? -value : value;
  while (rest > 0) {
    bits += 1;
    rest >>= 1;
  }
  return bits;
}

/** T.81 F.1.2.1: a negative value travels as the low `size` bits of `value - 1`. */
function writeValue(sink: JpegSink, value: number, size: number): void {
  sink.writeBits(value < 0 ? value + (1 << size) - 1 : value, size);
}

/** Returns this block's DC, which is the predictor for the next block of the same component. */
function writeBlock(
  sink: JpegSink,
  coefficients: Int32Array,
  dc: HuffmanEncoder,
  ac: HuffmanEncoder,
  previousDc: number,
): number {
  const dcValue = coefficients[0] ?? 0;
  const diff = dcValue - previousDc;
  const dcSize = magnitude(diff);
  sink.writeBits(dc.codes[dcSize] ?? 0, dc.lengths[dcSize] ?? 0);
  writeValue(sink, diff, dcSize);

  let last = 0;
  for (let k = 63; k >= 1; k -= 1) {
    if ((coefficients[ZIGZAG[k] ?? 0] ?? 0) !== 0) {
      last = k;
      break;
    }
  }
  let run = 0;
  for (let k = 1; k <= last; k += 1) {
    const value = coefficients[ZIGZAG[k] ?? 0] ?? 0;
    if (value === 0) {
      run += 1;
      continue;
    }
    while (run >= 16) {
      sink.writeBits(ac.codes[0xf0] ?? 0, ac.lengths[0xf0] ?? 0);
      run -= 16;
    }
    const size = magnitude(value);
    const symbol = (run << 4) | size;
    sink.writeBits(ac.codes[symbol] ?? 0, ac.lengths[symbol] ?? 0);
    writeValue(sink, value, size);
    run = 0;
  }
  if (last < 63) sink.writeBits(ac.codes[0] ?? 0, ac.lengths[0] ?? 0);
  return dcValue;
}

interface QuantTables {
  readonly luma: Uint8Array;
  readonly chroma: Uint8Array;
}

function writeQuantTable(sink: JpegSink, id: number, table: Uint8Array): void {
  sink.marker(MARKER.dqt);
  sink.word(67);
  sink.byte(id); // High nibble 0 == 8-bit precision.
  for (let k = 0; k < 64; k += 1) sink.byte(table[ZIGZAG[k] ?? 0] ?? 1);
}

function writeHuffmanTable(
  sink: JpegSink,
  id: number,
  bits: readonly number[],
  values: readonly number[],
): void {
  sink.marker(MARKER.dht);
  sink.word(19 + values.length);
  sink.byte(id);
  for (let i = 0; i < 16; i += 1) sink.byte(bits[i] ?? 0);
  for (const value of values) sink.byte(value);
}

function writeHeaders(sink: JpegSink, raster: Raster, quant: QuantTables): void {
  sink.marker(MARKER.soi);
  sink.marker(MARKER.app0);
  sink.word(16);
  sink.bytes([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0]); // 'JFIF\0', version 1.1, no density unit
  sink.bytes([0, 1, 0, 1, 0, 0]); // 1:1 pixel aspect, no thumbnail
  writeQuantTable(sink, 0, quant.luma);
  writeQuantTable(sink, 1, quant.chroma);
  sink.marker(MARKER.sof0);
  sink.word(17);
  sink.byte(8);
  sink.word(raster.height);
  sink.word(raster.width);
  sink.byte(3);
  sink.bytes([1, 0x22, 0]); // Y: h=2, v=2 — the 4:2:0 that halves both chroma planes
  sink.bytes([2, 0x11, 1]);
  sink.bytes([3, 0x11, 1]);
  writeHuffmanTable(sink, 0x00, STD_DC_LUMINANCE_BITS, STD_DC_LUMINANCE_VALUES);
  writeHuffmanTable(sink, 0x10, STD_AC_LUMINANCE_BITS, STD_AC_LUMINANCE_VALUES);
  writeHuffmanTable(sink, 0x01, STD_DC_CHROMINANCE_BITS, STD_DC_CHROMINANCE_VALUES);
  writeHuffmanTable(sink, 0x11, STD_AC_CHROMINANCE_BITS, STD_AC_CHROMINANCE_VALUES);
  sink.marker(MARKER.sos);
  sink.word(12);
  sink.byte(3);
  sink.bytes([1, 0x00, 2, 0x11, 3, 0x11]);
  sink.bytes([0, 63, 0]); // Baseline: the whole spectral band, no successive approximation
}

interface Component {
  readonly plane: Plane;
  readonly planeWidth: number;
  readonly divisors: Float64Array;
  readonly dc: HuffmanEncoder;
  readonly ac: HuffmanEncoder;
  /** Index into the DC predictor table — DC is differential per component across the scan. */
  readonly slot: number;
}

function writeScan(
  sink: JpegSink,
  planes: Planes,
  quant: QuantTables,
  mcusX: number,
  mcusY: number,
): void {
  const shared = { planeWidth: planes.chromaWidth, dc: DC_CHROMA, ac: AC_CHROMA } as const;
  const chromaDivisors = buildDivisors(quant.chroma);
  const y: Component = {
    plane: planes.luma,
    planeWidth: planes.lumaWidth,
    divisors: buildDivisors(quant.luma),
    dc: DC_LUMA,
    ac: AC_LUMA,
    slot: 0,
  };
  const cb: Component = { plane: planes.cb, divisors: chromaDivisors, slot: 1, ...shared };
  const cr: Component = { plane: planes.cr, divisors: chromaDivisors, slot: 2, ...shared };

  const block = new Float64Array(64);
  const coefficients = new Int32Array(64);
  const predictors = new Int32Array(3);
  const encodeOne = (
    { plane, planeWidth, divisors, dc, ac, slot }: Component,
    bx: number,
    by: number,
  ): void => {
    extractBlock(plane, planeWidth, bx, by, block);
    forwardDct(block);
    quantise(block, divisors, coefficients);
    predictors[slot] = writeBlock(sink, coefficients, dc, ac, predictors[slot] ?? 0);
  };
  for (let my = 0; my < mcusY; my += 1) {
    for (let mx = 0; mx < mcusX; mx += 1) {
      // Interleaved, in MCU order: four Y blocks, then the single Cb and Cr they share.
      for (let b = 0; b < 4; b += 1) encodeOne(y, mx * 2 + (b & 1), my * 2 + (b >> 1));
      encodeOne(cb, mx, my);
      encodeOne(cr, mx, my);
    }
  }
  sink.flushBits();
}

/** 1-100. A non-finite quality is a caller bug we absorb rather than a reason to fail an encode. */
function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return DEFAULT_JPEG_QUALITY;
  return Math.min(100, Math.max(1, Math.round(quality)));
}

/**
 * The raster as baseline JPEG bytes. Deterministic: same raster and quality, same bytes, always
 * — which is what lets a build cache a derived image by hashing its inputs.
 */
export function encodeJpeg(raster: Raster, quality: number = DEFAULT_JPEG_QUALITY): Uint8Array {
  const scaled = clampQuality(quality);
  const mcusX = Math.ceil(raster.width / MCU_SIZE);
  const mcusY = Math.ceil(raster.height / MCU_SIZE);
  const quant: QuantTables = {
    luma: scaleQuantTable(STD_LUMINANCE_QUANT, scaled),
    chroma: scaleQuantTable(STD_CHROMINANCE_QUANT, scaled),
  };
  const sink = new JpegSink(Math.min(1 << 22, raster.width * raster.height) + 1024);
  writeHeaders(sink, raster, quant);
  writeScan(sink, buildPlanes(raster, mcusX, mcusY), quant, mcusX, mcusY);
  sink.marker(MARKER.eoi);
  return sink.finish();
}
