// Single responsibility: proof for the PNG codec. Every fixture must decode to the exact bytes
// an independent encoder wrote, malformed files must be refused with a stable code, and encode
// must round trip losslessly. The CRC-32, Adler-32 and chunk walking here are written a second
// time on purpose — a checksum verified with the same code that produced it proves nothing.

import { describe, expect, test } from 'bun:test';
import {
  fixtureBytes,
  gradientPixel,
  type ImageFixture,
  PNG_GRADIENT_32X24,
  PNG_GRAY_2X2,
  PNG_GRAY_ALPHA_2X2,
  PNG_GRAY16_2X2,
  PNG_INTERLACED_8X8,
  PNG_PALETTE_4X1,
  PNG_RGB_3X2,
  PNG_RGBA_4X4,
} from './fixtures';
import { decodePng, encodePng } from './png';
import { MAX_IMAGE_PIXELS, type Raster, rasterFrom } from './raster';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Bit-by-bit rather than table-driven, so it shares no line of code with the codec's. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** The naive RFC 1950 form — no block deferral of the modulo. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const readU32 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) * 0x1000000 +
  (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));

function writeU32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
  /** Offset of the first data byte within the file, so a test can corrupt a known chunk. */
  readonly dataAt: number;
  readonly crcOk: boolean;
}

function chunksOf(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = readU32(bytes, at);
    const signed = bytes.subarray(at + 4, at + 8 + length);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    chunks.push({
      type,
      data: bytes.subarray(at + 8, at + 8 + length),
      dataAt: at + 8,
      crcOk: readU32(bytes, at + 8 + length) === crc32(signed),
    });
    at += length + 12;
  }
  return chunks;
}

function chunkOf(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Strips the zlib envelope and inflates. Copies because Bun's zlib rejects a shared-backed view. */
const unwrapZlib = (stream: Uint8Array): Uint8Array =>
  Bun.inflateSync(new Uint8Array(stream.subarray(2, stream.length - 4)));

function zlibWrap(raw: Uint8Array): Uint8Array {
  const deflated = Bun.deflateSync(new Uint8Array(raw));
  const out = new Uint8Array(deflated.length + 6);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(deflated, 2);
  writeU32(out, out.length - 4, adler32(raw));
  return out;
}

/** Rebuilds a fixture with its unfiltered scanline stream replaced, CRCs and envelope redone. */
function rebuilt(bytes: Uint8Array, mutate: (raw: Uint8Array) => Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [SIGNATURE];
  for (const piece of chunksOf(bytes)) {
    if (piece.type !== 'IDAT') {
      parts.push(chunkOf(piece.type, piece.data));
      continue;
    }
    parts.push(chunkOf('IDAT', zlibWrap(mutate(unwrapZlib(piece.data)))));
  }
  return concat(parts);
}

/** Builds a whole PNG, so a test can reach a colour type and depth no fixture happens to carry. */
function syntheticPng(
  size: readonly [number, number],
  bitDepth: number,
  colourType: number,
  rows: Uint8Array,
  extra: readonly (readonly [string, Uint8Array])[] = [],
): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, size[0]);
  writeU32(ihdr, 4, size[1]);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  const parts = [SIGNATURE, chunkOf('IHDR', ihdr)];
  for (const [type, data] of extra) parts.push(chunkOf(type, data));
  parts.push(chunkOf('IDAT', zlibWrap(rows)), chunkOf('IEND', new Uint8Array(0)));
  return concat(parts);
}

/**
 * The interlace flag is IHDR's 13th byte, so re-signing a fixture with it set produces the file
 * the decoder must refuse — a refusal decided from the header alone, before any IDAT is read.
 */
function asInterlaced(fixture: ImageFixture): Uint8Array {
  const bytes = fixtureBytes(fixture);
  const ihdr = Uint8Array.from(bytes.subarray(16, 29));
  ihdr[12] = 1;
  return concat([SIGNATURE, chunkOf('IHDR', ihdr), bytes.subarray(33)]);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'NOT_AN_ULTIMATE_ERROR';
  }
  return 'NOTHING_THROWN';
}

function causeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { cause?: unknown }).cause ?? '');
  }
  return '';
}

const PIXEL_FIXTURES: readonly (readonly [string, ImageFixture])[] = [
  ['truecolour with alpha', PNG_RGBA_4X4],
  ['truecolour', PNG_RGB_3X2],
  ['greyscale', PNG_GRAY_2X2],
  ['indexed colour with a tRNS table', PNG_PALETTE_4X1],
  ['greyscale with alpha', PNG_GRAY_ALPHA_2X2],
  ['16 bits per sample', PNG_GRAY16_2X2],
];

describe('decodePng', () => {
  for (const [label, fixture] of PIXEL_FIXTURES) {
    test(`decodes ${label} to its exact reference pixels`, () => {
      const expected = fixture.pixels ?? [];
      expect(expected.length).toBe(fixture.width * fixture.height * 4);
      const raster = decodePng(fixtureBytes(fixture));
      expect(raster.width).toBe(fixture.width);
      expect(raster.height).toBe(fixture.height);
      expect(Array.from(raster.pixels)).toEqual(Array.from(expected));
    });
  }

  test('decodes an adaptively filtered image, which exercises all five row filters', () => {
    const raster = decodePng(fixtureBytes(PNG_GRADIENT_32X24));
    expect(raster.width).toBe(32);
    expect(raster.height).toBe(24);
    const wrong: string[] = [];
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        const at = (y * raster.width + x) * 4;
        const [r, g, b] = gradientPixel(x, y);
        const got = [raster.pixels[at], raster.pixels[at + 1], raster.pixels[at + 2]];
        const alpha = raster.pixels[at + 3];
        if (got[0] !== r || got[1] !== g || got[2] !== b || alpha !== 255) {
          wrong.push(`${x},${y}: ${got.join()},${alpha} != ${r},${g},${b},255`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test('scales sub-byte greyscale samples across the full 0-255 range', () => {
    // Four 2-bit samples — 0, 1, 2, 3 — packed into one byte, behind a filter-0 marker.
    const png = syntheticPng([4, 1], 2, 0, Uint8Array.of(0, 0b00_01_10_11));
    expect(Array.from(decodePng(png).pixels)).toEqual([
      0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255,
    ]);
  });

  test('reads sub-byte palette samples as raw indices, never scaled', () => {
    const plte = Uint8Array.of(255, 0, 0, 0, 0, 255);
    const png = syntheticPng([2, 1], 4, 3, Uint8Array.of(0, 0x10), [['PLTE', plte]]);
    expect(Array.from(decodePng(png).pixels)).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
  });

  test('honours a tRNS key colour on a greyscale image', () => {
    const png = syntheticPng([2, 1], 8, 0, Uint8Array.of(0, 0, 255), [
      ['tRNS', Uint8Array.of(0, 0)],
    ]);
    expect(Array.from(decodePng(png).pixels)).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
  });

  test('refuses a palette index that runs past the end of PLTE', () => {
    const png = syntheticPng([2, 1], 8, 3, Uint8Array.of(0, 0, 5), [
      ['PLTE', Uint8Array.of(1, 2, 3)],
    ]);
    expect(codeOf(() => decodePng(png))).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('refuses an Adam7 interlaced PNG instead of garbling it', () => {
    // Both a real interlaced file and a re-flagged one: the refusal must key on the IHDR byte,
    // not on the sub-image layout, or a hostile flag would still reach the unfilter loop.
    const real = fixtureBytes(PNG_INTERLACED_8X8);
    expect(codeOf(() => decodePng(real))).toBe('X_IMAGE_UNSUPPORTED');
    expect(causeOf(() => decodePng(real))).toContain('Adam7');
    expect(codeOf(() => decodePng(asInterlaced(PNG_RGBA_4X4)))).toBe('X_IMAGE_UNSUPPORTED');
    expect(causeOf(() => decodePng(asInterlaced(PNG_RGBA_4X4)))).toContain('Adam7');
  });

  test('refuses a chunk whose CRC-32 does not match its bytes, naming the chunk', () => {
    const bytes = fixtureBytes(PNG_RGBA_4X4);
    const idat = chunksOf(bytes).find((piece) => piece.type === 'IDAT');
    expect(idat?.crcOk).toBe(true);
    const corrupt = Uint8Array.from(bytes);
    const at = (idat?.dataAt ?? 0) + 3;
    corrupt[at] = (corrupt[at] ?? 0) ^ 0xff;
    expect(codeOf(() => decodePng(corrupt))).toBe('X_IMAGE_DECODE_FAILED');
    expect(causeOf(() => decodePng(corrupt))).toContain('IDAT');
  });

  test('refuses a truncated file rather than decoding a partial image', () => {
    const bytes = fixtureBytes(PNG_RGBA_4X4);
    expect(codeOf(() => decodePng(bytes.subarray(0, bytes.length - 20)))).toBe(
      'X_IMAGE_DECODE_FAILED',
    );
  });

  test('refuses bytes that are not a PNG at all', () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
    expect(codeOf(() => decodePng(jpeg))).toBe('X_IMAGE_DECODE_FAILED');
    expect(codeOf(() => decodePng(new Uint8Array(4)))).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('refuses a colour type and bit depth combination the format does not define', () => {
    const ihdr = new Uint8Array(13);
    writeU32(ihdr, 0, 4);
    writeU32(ihdr, 4, 4);
    ihdr[8] = 16;
    ihdr[9] = 3;
    const file = concat([SIGNATURE, chunkOf('IHDR', ihdr), chunkOf('IEND', new Uint8Array(0))]);
    expect(codeOf(() => decodePng(file))).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('refuses an unknown scanline filter type', () => {
    const bad = rebuilt(fixtureBytes(PNG_GRAY_2X2), (raw) => {
      raw[0] = 5;
      return raw;
    });
    expect(codeOf(() => decodePng(bad))).toBe('X_IMAGE_DECODE_FAILED');
    expect(causeOf(() => decodePng(bad))).toContain('filter type 5');
  });

  test('refuses a stream that inflates to the wrong number of scanline bytes', () => {
    const short = rebuilt(fixtureBytes(PNG_GRAY_2X2), (raw) => raw.subarray(0, raw.length - 1));
    expect(codeOf(() => decodePng(short))).toBe('X_IMAGE_DECODE_FAILED');
  });

  test('refuses a declared size over the pixel budget before allocating for it', () => {
    const side = 30_000;
    expect(side * side).toBeGreaterThan(MAX_IMAGE_PIXELS);
    const ihdr = new Uint8Array(13);
    writeU32(ihdr, 0, side);
    writeU32(ihdr, 4, side);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const file = concat([SIGNATURE, chunkOf('IHDR', ihdr), chunkOf('IEND', new Uint8Array(0))]);
    expect(codeOf(() => decodePng(file))).toBe('X_IMAGE_TOO_LARGE');
  });
});

describe('encodePng', () => {
  const gradient = (): Raster => decodePng(fixtureBytes(PNG_GRADIENT_32X24));

  test('writes the PNG signature, the three required chunks, and correct CRCs', () => {
    const bytes = encodePng(gradient());
    expect(Array.from(bytes.subarray(0, 8))).toEqual(Array.from(SIGNATURE));
    const chunks = chunksOf(bytes);
    expect(chunks.map((piece) => piece.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks.every((piece) => piece.crcOk)).toBe(true);
    const ihdr = chunks[0]?.data ?? new Uint8Array(0);
    expect(readU32(ihdr, 0)).toBe(32);
    expect(readU32(ihdr, 4)).toBe(24);
    expect(Array.from(ihdr.subarray(8))).toEqual([8, 6, 0, 0, 0]);
  });

  test('wraps the deflate stream in a zlib envelope with a correct Adler-32', () => {
    const bytes = encodePng(gradient());
    const idat = chunksOf(bytes).find((piece) => piece.type === 'IDAT')?.data ?? new Uint8Array(0);
    expect(idat[0]).toBe(0x78);
    expect((((idat[0] ?? 0) << 8) | (idat[1] ?? 0)) % 31).toBe(0);
    const raw = unwrapZlib(idat);
    expect(readU32(idat, idat.length - 4)).toBe(adler32(raw));
    expect(raw.length).toBe(24 * (32 * 4 + 1));
  });

  test('chooses a filter per scanline instead of writing filter 0 everywhere', () => {
    const raster = gradient();
    const idat =
      chunksOf(encodePng(raster)).find((piece) => piece.type === 'IDAT')?.data ?? new Uint8Array(0);
    const raw = unwrapZlib(idat);
    const filters = new Set<number>();
    for (let y = 0; y < raster.height; y += 1) {
      filters.add(raw[y * (raster.width * 4 + 1)] ?? 0);
    }
    expect(filters.size).toBeGreaterThan(1);
  });

  test('round trips a raster carrying alpha, unchanged', () => {
    const source = decodePng(fixtureBytes(PNG_RGBA_4X4));
    const back = decodePng(encodePng(source));
    expect(back.width).toBe(source.width);
    expect(back.height).toBe(source.height);
    expect(Array.from(back.pixels)).toEqual(Array.from(source.pixels));
  });

  test('round trips a single pixel', () => {
    const source = rasterFrom(1, 1, Uint8ClampedArray.of(12, 34, 56, 78));
    const back = decodePng(encodePng(source));
    expect(back.width).toBe(1);
    expect(back.height).toBe(1);
    expect(Array.from(back.pixels)).toEqual([12, 34, 56, 78]);
  });

  test('round trips a full gradient, every byte identical', () => {
    const source = gradient();
    const back = decodePng(encodePng(source));
    expect(Array.from(back.pixels)).toEqual(Array.from(source.pixels));
  });

  test('is deterministic — the same raster always encodes to the same bytes', () => {
    const source = gradient();
    expect(Array.from(encodePng(source))).toEqual(Array.from(encodePng(source)));
  });
});
