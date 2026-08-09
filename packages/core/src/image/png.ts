// Single responsibility: the PNG codec. Every colour type, bit depth and row filter the format
// allows decodes into the one 8-bit RGBA raster; encoding has exactly one output shape (colour
// type 6, adaptive filters). Chunk CRCs are verified on the way in because a decoder that
// tolerates a corrupt chunk hands the app wrong pixels instead of a coded error.

import { imageDecodeFailed, imageUnsupported } from './errors';
import {
  adler32,
  chunk,
  crc32,
  EMPTY_CHUNK_DATA,
  joinBytes,
  PNG_SIGNATURE,
  paeth,
  readU32,
  unshared,
  writeU32,
} from './png-bytes';
import { assertPixelBudget, type Raster, rasterFrom } from './raster';

/** Bytes per pixel of the encoder's one output shape, and its filter offset. */
const RGBA_BPP = 4;

/** Samples per pixel, by colour type. A palette row carries one index, not one colour. */
const CHANNELS = Uint8Array.of(1, 0, 3, 1, 2, 0, 4);

/**
 * PNG spec table 11.1, keyed by colour type. Every legal depth is a power of two, so the set of
 * them masks directly — which is also why a depth like 3 has to be rejected as not one at all.
 */
const LEGAL_DEPTHS: Readonly<Record<number, number>> = {
  0: 1 | 2 | 4 | 8 | 16,
  2: 8 | 16,
  3: 1 | 2 | 4 | 8,
  4: 8 | 16,
  6: 8 | 16,
};

const channelsOf = (colourType: number): number => CHANNELS[colourType] ?? 1;

const isLegalShape = (colourType: number, bitDepth: number): boolean =>
  bitDepth !== 0 &&
  (bitDepth & (bitDepth - 1)) === 0 &&
  ((LEGAL_DEPTHS[colourType] ?? 0) & bitDepth) === bitDepth;

/** Stretches a sub-byte sample across the full range, so depth 1 reads 0/255 rather than 0/1. */
const UPSCALE: Readonly<Record<number, number>> = { 1: 255, 2: 85, 4: 17 };

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colourType: number;
}

function assertSignature(bytes: Uint8Array): void {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] === PNG_SIGNATURE[i]) continue;
    const found = Array.from(bytes.subarray(0, 8));
    throw imageDecodeFailed(`the bytes are not a PNG: signature reads ${found}`, {
      signature: found,
    });
  }
}

function readHeader(bytes: Uint8Array, at: number, length: number): PngHeader {
  if (length !== 13) {
    throw imageDecodeFailed(`the PNG IHDR chunk carries ${length} bytes, not the required 13`, {
      length,
    });
  }
  const width = readU32(bytes, at);
  const height = readU32(bytes, at + 4);
  const bitDepth = bytes[at + 8] ?? 0;
  const colourType = bytes[at + 9] ?? 0;
  const compression = bytes[at + 10] ?? 0;
  const filter = bytes[at + 11] ?? 0;
  const interlace = bytes[at + 12] ?? 0;
  if (!isLegalShape(colourType, bitDepth)) {
    throw imageDecodeFailed(
      `the PNG declares colour type ${colourType} at ${bitDepth} bits, a pair the format omits`,
      { colourType, bitDepth },
    );
  }
  if (compression !== 0 || filter !== 0 || interlace > 1) {
    throw imageDecodeFailed(
      `the PNG declares compression ${compression}, filter method ${filter}, interlace ` +
        `${interlace}; only 0, 0 and 0-or-1 have ever been defined`,
      { compression, filter, interlace },
    );
  }
  // Before a single byte is allocated: the declared size is the only bomb guard that is cheap.
  assertPixelBudget(width, height, 'png');
  if (interlace === 1) {
    throw imageUnsupported(
      'the file is an Adam7 interlaced PNG, which the built-in decoder does not implement',
      'convert the file to a non-interlaced PNG: `convert in.png -interlace none out.png`',
      { width, height },
    );
  }
  return { width, height, bitDepth, colourType };
}

/**
 * PNG wraps its deflate stream in zlib, and Bun's `inflateSync` only speaks RAW deflate — so the
 * 2-byte header and 4-byte Adler-32 trailer are validated and stripped here rather than handed on.
 */
function inflateIdat(stream: Uint8Array): Uint8Array {
  const cmf = stream[0] ?? 0;
  const flg = stream[1] ?? 0;
  const check = ((cmf << 8) | flg) >>> 0;
  if (stream.length < 6 || (cmf & 0x0f) !== 8 || check % 31 !== 0) {
    throw imageDecodeFailed(
      `the PNG IDAT stream is ${stream.length} bytes opening 0x${check.toString(16)}, not zlib`,
      { header: check, compressed: stream.length },
    );
  }
  if ((flg & 0x20) !== 0) {
    throw imageUnsupported(
      'the PNG IDAT stream sets a zlib preset dictionary, which the PNG format forbids',
      're-export the file with a conformant encoder: `convert in.png out.png`',
    );
  }
  try {
    return Bun.inflateSync(unshared(stream.subarray(2, stream.length - 4)));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw imageDecodeFailed(`the PNG IDAT stream could not be inflated: ${why}`, {
      compressed: stream.length,
    });
  }
}

/** Reverses the per-scanline filter in place, leaving each row's raw bytes where they lay. */
function unfilter(raw: Uint8Array, height: number, rowBytes: number, bpp: number): void {
  const stride = rowBytes + 1;
  for (let y = 0; y < height; y += 1) {
    const at = y * stride;
    const filter = raw[at] ?? 0;
    const row = at + 1;
    const prev = row - stride;
    const hasPrev = y > 0;
    switch (filter) {
      case 0:
        break;
      case 1: {
        for (let i = bpp; i < rowBytes; i += 1) {
          raw[row + i] = ((raw[row + i] ?? 0) + (raw[row + i - bpp] ?? 0)) & 0xff;
        }
        break;
      }
      case 2: {
        if (!hasPrev) break;
        for (let i = 0; i < rowBytes; i += 1) {
          raw[row + i] = ((raw[row + i] ?? 0) + (raw[prev + i] ?? 0)) & 0xff;
        }
        break;
      }
      // Average and Paeth read the same three neighbours; only the predictor differs.
      case 3:
      case 4: {
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? (raw[row + i - bpp] ?? 0) : 0;
          const up = hasPrev ? (raw[prev + i] ?? 0) : 0;
          const upLeft = hasPrev && i >= bpp ? (raw[prev + i - bpp] ?? 0) : 0;
          const guess = filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
          raw[row + i] = ((raw[row + i] ?? 0) + guess) & 0xff;
        }
        break;
      }
      default:
        throw imageDecodeFailed(
          `PNG scanline ${y} declares filter type ${filter}, which is not one of 0-4`,
          { row: y, filter },
        );
    }
  }
}

/** One scanline of unfiltered bytes into whole samples, at whatever precision the file uses. */
function readSamples(raw: Uint8Array, at: number, out: Uint16Array, bitDepth: number): void {
  const count = out.length;
  if (bitDepth === 8) {
    for (let i = 0; i < count; i += 1) out[i] = raw[at + i] ?? 0;
    return;
  }
  if (bitDepth === 16) {
    for (let i = 0; i < count; i += 1) {
      out[i] = ((raw[at + i * 2] ?? 0) << 8) | (raw[at + i * 2 + 1] ?? 0);
    }
    return;
  }
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  for (let i = 0; i < count; i += 1) {
    const byte = raw[at + ((i / perByte) | 0)] ?? 0;
    out[i] = (byte >> (8 - bitDepth * ((i % perByte) + 1))) & mask;
  }
}

/**
 * `tRNS` on a greyscale or truecolour image is not a table: it names ONE sample value that is
 * fully transparent, at the image's own bit depth. Ignoring it drops a logo's cut-out.
 */
function transparentKey(colourType: number, trns: Uint8Array | undefined): Uint16Array | undefined {
  if (trns === undefined || (colourType !== 0 && colourType !== 2)) return undefined;
  const samples = colourType === 2 ? 3 : 1;
  if (trns.length < samples * 2) return undefined;
  const key = new Uint16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    key[i] = ((trns[i * 2] ?? 0) << 8) | (trns[i * 2 + 1] ?? 0);
  }
  return key;
}

/**
 * Which sample of a pixel feeds R, G, B and A, by colour type; `-1` is "no alpha sample". Stating
 * the mapping once stops four colour types from becoming four loops that can each be wrong.
 */
const RGBA_SOURCE: Readonly<Record<number, readonly [number, number, number, number]>> = {
  0: [0, 0, 0, -1],
  2: [0, 1, 2, -1],
  4: [0, 0, 0, 1],
  6: [0, 1, 2, 3],
};

/** Opaque unless a `tRNS` key colour matches this pixel's samples exactly. */
function opacityFor(samples: Uint16Array, at: number, key: Uint16Array | undefined): number {
  if (key === undefined) return 255;
  for (let i = 0; i < key.length; i += 1) {
    if (samples[at + i] !== key[i]) return 255;
  }
  return 0;
}

function expand(
  raw: Uint8Array,
  header: PngHeader,
  palette: Uint8Array | undefined,
  trns: Uint8Array | undefined,
): Uint8ClampedArray {
  const { width, height, bitDepth, colourType } = header;
  if (colourType === 3 && palette === undefined) {
    throw imageDecodeFailed('the PNG is indexed colour but carries no PLTE chunk');
  }
  const plte = palette ?? EMPTY_CHUNK_DATA;
  const entries = (plte.length / 3) | 0;
  const channels = channelsOf(colourType);
  const stride = Math.ceil((width * channels * bitDepth) / 8) + 1;
  const upscale = UPSCALE[bitDepth] ?? 1;
  const key = transparentKey(colourType, trns);
  const samples = new Uint16Array(width * channels);
  const pixels = new Uint8ClampedArray(width * height * 4);
  const [sr, sg, sb, sa] = RGBA_SOURCE[colourType] ?? [0, 0, 0, -1];
  const byteOf = (sample: number): number => (bitDepth === 16 ? sample >>> 8 : sample * upscale);

  for (let y = 0; y < height; y += 1) {
    readSamples(raw, y * stride + 1, samples, bitDepth);
    let p = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      if (colourType === 3) {
        const index = samples[s] ?? 0;
        if (index >= entries) {
          throw imageDecodeFailed(
            `PNG pixel ${x},${y} uses palette index ${index} but PLTE holds ${entries} entries`,
            { x, y, index, entries },
          );
        }
        pixels[p] = plte[index * 3] ?? 0;
        pixels[p + 1] = plte[index * 3 + 1] ?? 0;
        pixels[p + 2] = plte[index * 3 + 2] ?? 0;
        pixels[p + 3] = trns !== undefined && index < trns.length ? (trns[index] ?? 255) : 255;
      } else {
        pixels[p] = byteOf(samples[s + sr] ?? 0);
        pixels[p + 1] = byteOf(samples[s + sg] ?? 0);
        pixels[p + 2] = byteOf(samples[s + sb] ?? 0);
        pixels[p + 3] = sa >= 0 ? byteOf(samples[s + sa] ?? 0) : opacityFor(samples, s, key);
      }
      p += 4;
    }
  }
  return pixels;
}

/** PNG bytes in, RGBA out. Every chunk is CRC-checked before a single pixel is believed. */
export function decodePng(bytes: Uint8Array): Raster {
  assertSignature(bytes);
  let header: PngHeader | undefined;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let ended = false;
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const dataAt = offset + 8;
    const crcAt = dataAt + length;
    if (crcAt + 4 > bytes.length) {
      throw imageDecodeFailed(
        `the PNG ends after ${bytes.length} bytes, inside chunk ${type} at offset ${offset}`,
        { chunk: type, offset, declared: length },
      );
    }
    const declared = readU32(bytes, crcAt);
    const actual = crc32(bytes, offset + 4, crcAt);
    if (declared !== actual) {
      throw imageDecodeFailed(
        `PNG chunk ${type} fails its CRC-32: the file says ${declared}, the bytes hash to ${actual}`,
        { chunk: type, declared, actual },
      );
    }
    if (header === undefined && type !== 'IHDR') {
      throw imageDecodeFailed(`the first PNG chunk is ${type}, not IHDR`, { chunk: type });
    }
    if (type === 'IHDR') {
      if (header !== undefined) throw imageDecodeFailed('the PNG carries more than one IHDR chunk');
      header = readHeader(bytes, dataAt, length);
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataAt, crcAt);
    } else if (type === 'tRNS') {
      trns = bytes.subarray(dataAt, crcAt);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataAt, crcAt));
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset = crcAt + 4;
  }

  if (!ended) throw imageDecodeFailed('the PNG never reaches IEND, so the file is truncated');
  if (header === undefined) throw imageDecodeFailed('the PNG carries no IHDR chunk');
  if (idat.length === 0)
    throw imageDecodeFailed('the PNG carries no IDAT chunk, so it has no rows');

  const { width, height, bitDepth, colourType } = header;
  const channels = channelsOf(colourType);
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expected = height * (rowBytes + 1);
  const raw = inflateIdat(joinBytes(idat));
  if (raw.length !== expected) {
    throw imageDecodeFailed(
      `the PNG inflates to ${raw.length} bytes but ${width}x${height} at ${bitDepth} bits over ` +
        `${channels} channels needs exactly ${expected}`,
      { inflated: raw.length, expected },
    );
  }
  unfilter(raw, height, rowBytes, Math.max(1, Math.ceil((bitDepth * channels) / 8)));
  return rasterFrom(width, height, expand(raw, header, palette, trns));
}

/**
 * Filters one scanline into `out`, scored by the libpng heuristic: the sum of its bytes read as
 * signed. The lowest sum is the row deflate compresses best, which is why an encoder that always
 * wrote filter 0 would ship files roughly twice this size. A negative `prev` is "no row above".
 */
function filterScanline(
  pixels: Uint8ClampedArray,
  row: number,
  prev: number,
  stride: number,
  filter: number,
  out: Uint8Array,
): number {
  let score = 0;
  const hasPrev = prev >= 0;
  for (let i = 0; i < stride; i += 1) {
    const raw = pixels[row + i] ?? 0;
    const left = i >= RGBA_BPP ? (pixels[row + i - RGBA_BPP] ?? 0) : 0;
    const up = hasPrev ? (pixels[prev + i] ?? 0) : 0;
    let value = raw;
    if (filter === 1) value = raw - left;
    else if (filter === 2) value = raw - up;
    else if (filter === 3) value = raw - ((left + up) >> 1);
    else if (filter === 4) {
      const upLeft = hasPrev && i >= RGBA_BPP ? (pixels[prev + i - RGBA_BPP] ?? 0) : 0;
      value = raw - paeth(left, up, upLeft);
    }
    value &= 0xff;
    out[i] = value;
    score += value < 128 ? value : 256 - value;
  }
  return score;
}

/**
 * RGBA in, PNG bytes out — always 8-bit colour type 6, non-interlaced. Branching on opacity would
 * give the framework two encoders to keep correct, and alpha on an opaque image is nearly free
 * after deflate, so there is one path.
 */
export function encodePng(raster: Raster): Uint8Array {
  const { width, height, pixels } = raster;
  const stride = width * 4;
  const filtered = new Uint8Array(height * (stride + 1));
  const scratch = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const at = y * (stride + 1);
    let best = Number.POSITIVE_INFINITY;
    for (let filter = 0; filter <= 4; filter += 1) {
      const score = filterScanline(pixels, row, y > 0 ? row - stride : -1, stride, filter, scratch);
      if (score >= best) continue;
      best = score;
      filtered[at] = filter;
      filtered.set(scratch, at + 1);
    }
  }

  // `Bun.deflateSync` emits RAW deflate, so the zlib envelope PNG requires is written by hand.
  const deflated = Bun.deflateSync(filtered);
  const idat = new Uint8Array(deflated.length + 6);
  idat.set([0x78, 0x01]);
  idat.set(deflated, 2);
  writeU32(idat, deflated.length + 2, adler32(filtered));

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr.set([8, 6], 8);
  return joinBytes([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', EMPTY_CHUNK_DATA),
  ]);
}
