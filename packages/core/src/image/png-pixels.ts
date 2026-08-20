// Single responsibility: the raw-pixel seam — 8-bit RGBA in and out of a PNG container. `Bun.Image`
// owns every real codec now, but it has no compositor and no raw-pixel terminal, and the maskable
// safe zone `@ultimat3/pwa` promises is a composite. So this file exists for exactly that one hop:
// Bun re-encodes to PNG, this reads the pixels back, `canvas.ts` blits, this writes them again.

import { imageDecodeFailed, imageUnsupported } from './errors';
import {
  adler32,
  chunk,
  joinBytes,
  PNG_SIGNATURE,
  paeth,
  readU32,
  unshared,
  writeU32,
} from './png-bytes';
import { type Raster, rasterFrom } from './raster';

/** Truecolour with alpha, 8 bits per channel — the ONE shape `Raster` is. */
const RGBA_COLOR_TYPE = 8 << 4;
const BYTES_PER_PIXEL = 4;

const RAW_FIX =
  'run the bytes through `transformImageBytes()` instead — it is backed by Bun.Image, which ' +
  'reads every real format; the raw-pixel seam is 8-bit RGBA PNG only';

// --------------------------------------------------------------------------------- encode

/**
 * Always filter 0. An adaptive filter buys a few percent on a placeholder or an icon and costs a
 * second thing to be wrong in; every consumer of these bytes re-encodes through Bun anyway.
 */
function filterRows(raster: Raster): Uint8Array<ArrayBuffer> {
  const stride = raster.width * BYTES_PER_PIXEL;
  const out = new Uint8Array((stride + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    out[y * (stride + 1)] = 0;
    out.set(raster.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return out;
}

/** RGBA pixels to PNG bytes. Deterministic: the same raster is the same bytes, every run. */
export function encodeImage(raster: Raster, format: 'png' = 'png'): Uint8Array {
  if (format !== 'png') {
    throw imageUnsupported(`the raw-pixel seam writes PNG, not ${String(format)}`, RAW_FIX, {
      format,
    });
  }
  const header = new Uint8Array(13);
  writeU32(header, 0, raster.width);
  writeU32(header, 4, raster.height);
  header[8] = 8;
  header[9] = 6;
  const filtered = filterRows(raster);
  // `windowBits: -15` asks for RAW deflate: PNG supplies the zlib envelope itself, and Bun's
  // documented default (15, zlib-wrapped) would nest a second one inside it.
  const deflated = Bun.deflateSync(filtered, { windowBits: -15 });
  const idat = new Uint8Array(deflated.length + 6);
  idat[0] = 0x78;
  idat[1] = 0x01;
  idat.set(deflated, 2);
  writeU32(idat, deflated.length + 2, adler32(filtered));
  return joinBytes([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// --------------------------------------------------------------------------------- decode

interface PngHeader {
  readonly width: number;
  readonly height: number;
}

function readHeader(bytes: Uint8Array): PngHeader {
  if (bytes.length < 33) {
    throw imageDecodeFailed(`a PNG is at least 33 bytes; these are ${bytes.length}`, {
      length: bytes.length,
    });
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw imageUnsupported('the raw-pixel seam reads PNG, and these bytes are not one', RAW_FIX, {
        length: bytes.length,
      });
    }
  }
  const depth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  // Bun's encoder emits 8-bit RGBA, non-interlaced, for every source — verified, and the only
  // shape this seam ever has to read. Anything else came from outside and says so.
  if (((depth ?? 0) << 4) + (colorType ?? 0) !== RGBA_COLOR_TYPE + 6 || interlace !== 0) {
    throw imageUnsupported(
      `the PNG is ${String(depth)}-bit colour type ${String(colorType)}` +
        `${interlace === 0 ? '' : ', interlaced'}, not 8-bit RGBA`,
      RAW_FIX,
      { depth, colorType, interlace },
    );
  }
  return { width: readU32(bytes, 16), height: readU32(bytes, 20) };
}

/** Every IDAT concatenated: a PNG may split its stream across any number of them. */
function idatStream(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = readU32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') break;
    at += 12 + length;
  }
  if (parts.length === 0) {
    throw imageDecodeFailed('the PNG carries no IDAT chunk, so it declares no pixels', {});
  }
  const stream = joinBytes(parts);
  try {
    // The 2-byte zlib header and the 4-byte Adler-32 trailer are PNG's envelope, stripped here
    // so the payload inflates as RAW deflate — see the encoder above for the mirror image.
    return Bun.inflateSync(unshared(stream.subarray(2, stream.length - 4)), { windowBits: -15 });
  } catch {
    throw imageDecodeFailed(`the PNG IDAT stream (${stream.length} bytes) could not be inflated`, {
      length: stream.length,
    });
  }
}

/**
 * The five PNG predictors, undone row by row. `raw` is `[filter, ...pixels]` per row.
 *
 * Reconstructed into a `Uint8Array`, never straight into the `Uint8ClampedArray` a `Raster` holds:
 * every filter is arithmetic MOD 256 and a clamped array saturates instead, so `255 + 1` lands on
 * 255 rather than 0. That is invisible on a filter-0 stream (ours) and wrong on every adaptive one
 * (libspng's) — the alpha channel of a transparent pixel first, which is exactly the case a PWA
 * icon is made of.
 */
function unfilter(raw: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const stride = width * BYTES_PER_PIXEL;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)] ?? 0;
    if (type > 4) {
      throw imageDecodeFailed(`PNG row ${y} declares filter ${type}, and there are only 0-4`, {
        row: y,
        filter: type,
      });
    }
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[from + i] ?? 0;
      const a = i >= BYTES_PER_PIXEL ? (out[to + i - BYTES_PER_PIXEL] ?? 0) : 0;
      const b = y > 0 ? (out[to - stride + i] ?? 0) : 0;
      const c = y > 0 && i >= BYTES_PER_PIXEL ? (out[to - stride + i - BYTES_PER_PIXEL] ?? 0) : 0;
      if (type === 0) out[to + i] = x;
      else if (type === 1) out[to + i] = x + a;
      else if (type === 2) out[to + i] = x + b;
      else if (type === 3) out[to + i] = x + ((a + b) >> 1);
      else out[to + i] = x + paeth(a, b, c);
    }
  }
  return new Uint8ClampedArray(out.buffer, out.byteOffset, out.length);
}

/** PNG bytes to RGBA pixels. Refuses anything but 8-bit RGBA, naming the pipeline that reads it. */
export function decodeImage(bytes: Uint8Array): Raster {
  const { width, height } = readHeader(bytes);
  const raw = idatStream(bytes);
  const expected = (width * BYTES_PER_PIXEL + 1) * height;
  if (raw.length !== expected) {
    throw imageDecodeFailed(
      `the PNG inflates to ${raw.length} bytes but ${width}x${height} RGBA needs ${expected}`,
      { inflated: raw.length, expected, width, height },
    );
  }
  return rasterFrom(width, height, unfilter(raw, width, height));
}
