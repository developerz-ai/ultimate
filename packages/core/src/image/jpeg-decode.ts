// Single responsibility: turning a baseline or extended sequential Huffman JPEG (SOF0/SOF1) into
// RGBA — the marker walk, the entropy-coded scan, the inverse DCT and the sample planes. What each
// segment DECLARES, and which codings are refused by name, is `jpeg-headers.ts`; this file is the
// algorithm those declarations describe.

import { imageDecodeFailed } from './errors';
import {
  assertSupportedCoding,
  type Component,
  type Frame,
  hex,
  isAdobe,
  readFrame,
  readQuantTables,
  readScanHeader,
  readU16,
  type ScanComponent,
} from './jpeg-headers';
import { type HuffmanTable, JpegBitReader, readHuffmanTables } from './jpeg-huffman';
import { ycbcrToRgb, ZIGZAG } from './jpeg-tables';
import { type Raster, rasterFrom } from './raster';

const SQRT2 = Math.SQRT2;

/** Reused across every block of every image: the decoder is synchronous and single-threaded. */
const COEF = new Int32Array(64);
const WORK = new Float32Array(64);

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

/** Leaves the walk at the next marker, or at the end when the file carries no EOI. */
function skipToMarker(bytes: Uint8Array, from: number): number {
  for (let at = from; at + 1 < bytes.length; at += 1) {
    if ((bytes[at] ?? 0) === 0xff && (bytes[at + 1] ?? 0) !== 0x00) return at;
  }
  return bytes.length;
}

/** One scan's entropy-coded data, from the byte after its header to the marker that ends it. */
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
  const scan: readonly ScanComponent[] = readScanHeader(seg, frame, quant, dcTables, acTables);
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
    assertSupportedCoding(marker);
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
