// Single responsibility: proving the JPEG decoder against bytes an independent encoder produced.
// JPEG is lossy, so every assertion is closeness to the formula the fixture was drawn from — an
// exact-equality test would either be impossible or would only prove the codec agrees with itself.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '../errors';
import {
  fixtureBytes,
  type ImageFixture,
  JPEG_420_16X16,
  JPEG_420_ODD_33X17,
  JPEG_444_16X16,
  JPEG_GRAY_16X16,
  JPEG_PROGRESSIVE_16X16,
  jpegPixel,
  oddJpegPixel,
} from './fixtures';
import { decodeJpeg } from './jpeg-decode';
import { rgbToYcbcr } from './jpeg-tables';
import type { Raster } from './raster';

type Formula = (x: number, y: number) => readonly [number, number, number];

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

const at = (raster: Raster, x: number, y: number): readonly [number, number, number, number] => {
  const o = (y * raster.width + x) * 4;
  return [
    raster.pixels[o] ?? 0,
    raster.pixels[o + 1] ?? 0,
    raster.pixels[o + 2] ?? 0,
    raster.pixels[o + 3] ?? 0,
  ];
};

/** Mean absolute error per channel, and the worst single channel, against the source formula. */
function channelError(raster: Raster, formula: Formula): { mean: number; max: number } {
  let sum = 0;
  let max = 0;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const got = at(raster, x, y);
      const want = formula(x, y);
      for (let c = 0; c < 3; c += 1) {
        const delta = Math.abs((got[c] ?? 0) - (want[c] ?? 0));
        sum += delta;
        max = Math.max(max, delta);
      }
    }
  }
  return { mean: sum / (raster.width * raster.height * 3), max };
}

/** Luma only — chroma is half resolution under 4:2:0, so per-channel bounds there prove nothing. */
function lumaError(raster: Raster, formula: Formula): number {
  let sum = 0;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const [r, g, b] = at(raster, x, y);
      const [wr, wg, wb] = formula(x, y);
      sum += Math.abs(luma(r, g, b) - luma(wr, wg, wb));
    }
  }
  return sum / (raster.width * raster.height);
}

/** Returns the coded error a call threw, or undefined — never a bare `throw` of its own. */
function failure(run: () => unknown): UltimateError | undefined {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error : undefined;
  }
  return undefined;
}

const segment = (marker: number, body: readonly number[]): readonly number[] => [
  0xff,
  marker,
  ((body.length + 2) >> 8) & 0xff,
  (body.length + 2) & 0xff,
  ...body,
];

const jpegOf = (...parts: ReadonlyArray<readonly number[]>): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9]);

const frame = (marker: number, w: number, h: number, precision = 8, components = 1) =>
  segment(marker, [
    precision,
    (h >> 8) & 0xff,
    h & 0xff,
    (w >> 8) & 0xff,
    w & 0xff,
    components,
    ...Array.from({ length: components }, (_, i) => [i + 1, 0x11, 0]).flat(),
  ]);

const SOS_ONE_COMPONENT = segment(0xda, [1, 1, 0x00, 0, 63, 0]);
const DQT_FLAT = segment(0xdb, [0, ...new Array<number>(64).fill(16)]);

/**
 * Re-emits every DQT table in its 16-bit form with identical values. A decoder that ignores the
 * precision nibble reads the high zero byte of each entry as the whole coefficient and produces a
 * flat grey image, so decoding this to the same pixels is the only proof the nibble is honoured.
 */
function widenQuantTables(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    if (bytes[cursor] === 0xff && bytes[cursor + 1] === 0xda) break; // entropy data follows
    if (bytes[cursor] !== 0xff || bytes[cursor + 1] !== 0xdb) {
      out.push(bytes[cursor] ?? 0);
      cursor += 1;
      continue;
    }
    const length = ((bytes[cursor + 2] ?? 0) << 8) | (bytes[cursor + 3] ?? 0);
    const body = bytes.subarray(cursor + 4, cursor + 2 + length);
    const wide: number[] = [];
    let i = 0;
    while (i < body.length) {
      wide.push(0x10 | ((body[i] ?? 0) & 15));
      i += 1;
      for (let k = 0; k < 64; k += 1, i += 1) wide.push(0, body[i] ?? 0);
    }
    out.push(...segment(0xdb, wide));
    cursor += 2 + length;
  }
  return Uint8Array.from([...out, ...bytes.subarray(cursor)]);
}

/** Splices an APP14 `Adobe` marker in behind SOI, which is where a real one sits. */
const withAdobe = (bytes: Uint8Array, transform: number): Uint8Array =>
  Uint8Array.from([
    0xff,
    0xd8,
    ...segment(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, transform]),
    ...bytes.subarray(2),
  ]);

const decode = (fixture: ImageFixture): Raster => decodeJpeg(fixtureBytes(fixture));

describe('decodeJpeg', () => {
  test('decodes a 4:4:4 baseline JPEG close to the pixels it was drawn from', () => {
    const raster = decode(JPEG_444_16X16);
    expect([raster.width, raster.height]).toEqual([16, 16]);
    expect(raster.pixels.length).toBe(16 * 16 * 4);
    const { mean, max } = channelError(raster, jpegPixel);
    expect(max).toBeLessThanOrEqual(12);
    expect(mean).toBeLessThan(4);
  });

  test('every pixel of the 4:4:4 fixture is opaque', () => {
    const raster = decode(JPEG_444_16X16);
    for (let i = 3; i < raster.pixels.length; i += 4) expect(raster.pixels[i]).toBe(255);
  });

  test('upsamples 4:2:0 chroma to full resolution', () => {
    const raster = decode(JPEG_420_16X16);
    expect([raster.width, raster.height]).toEqual([16, 16]);
    expect(lumaError(raster, jpegPixel)).toBeLessThan(5);
  });

  test('crops the MCU padding off odd dimensions under 4:2:0', () => {
    const raster = decode(JPEG_420_ODD_33X17);
    expect([raster.width, raster.height]).toEqual([33, 17]);
    expect(raster.pixels.length).toBe(33 * 17 * 4);
    expect(lumaError(raster, oddJpegPixel)).toBeLessThan(8);
  });

  test('replicates a single luma component across R, G and B', () => {
    const raster = decode(JPEG_GRAY_16X16);
    expect([raster.width, raster.height]).toEqual([16, 16]);
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const [r, g, b, a] = at(raster, x, y);
        expect(g).toBe(r);
        expect(b).toBe(r);
        expect(a).toBe(255);
      }
    }
    // A greyscale decode that lost its DC term would be uniform; the source is a gradient.
    expect(at(raster, 15, 15)[0]).toBeGreaterThan(at(raster, 0, 0)[0]);
  });

  test('reads 16-bit precision quantisation tables', () => {
    const wide = decodeJpeg(widenQuantTables(fixtureBytes(JPEG_444_16X16)));
    const narrow = decode(JPEG_444_16X16);
    expect([wide.width, wide.height]).toEqual([16, 16]);
    expect(Array.from(wide.pixels)).toEqual(Array.from(narrow.pixels));
  });

  test('an Adobe APP14 transform of 0 means the samples are already RGB', () => {
    const ycc = decode(JPEG_444_16X16);
    const asRgb = decodeJpeg(withAdobe(fixtureBytes(JPEG_444_16X16), 0));
    let worst = 0;
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const [r, g, b] = at(ycc, x, y);
        const raw = rgbToYcbcr(r, g, b);
        const got = at(asRgb, x, y);
        for (let c = 0; c < 3; c += 1) {
          worst = Math.max(worst, Math.abs((got[c] ?? 0) - (raw[c] ?? 0)));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(2);
    // …and transform 1 (YCbCr) leaves the default conversion in place.
    const explicitYcc = decodeJpeg(withAdobe(fixtureBytes(JPEG_444_16X16), 1));
    expect(Array.from(explicitYcc.pixels)).toEqual(Array.from(ycc.pixels));
  });

  test('refuses a progressive JPEG by name instead of decoding noise', () => {
    const error = failure(() => decode(JPEG_PROGRESSIVE_16X16));
    expect(error?.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(error?.message).toMatch(/progressive/i);
    expect(error?.message).toMatch(/SOF2/);
    expect(error?.fix).toContain('convert in.jpg -interlace none baseline.jpg');
  });

  test.each([
    ['a spectral band narrower than the whole 0-63', [1, 1, 0x00, 1, 5, 0x00], /coefficients 1-5/],
    ['a successive-approximation refinement', [1, 1, 0x00, 0, 63, 0x21], /approximation 2\/1/],
  ])('refuses a sequential frame whose scan declares %s', (_name, sos, pattern) => {
    // SOF0 promises sequential coding, so the scan must code every coefficient at full precision.
    // A progressive scan's shape behind a baseline frame header would have `decodeBlock` read
    // partial coefficients as whole ones — a plausible, wrong image instead of a named refusal.
    const bytes = jpegOf(DQT_FLAT, frame(0xc0, 8, 8), segment(0xda, sos), [0x00, 0x00]);
    const error = failure(() => decodeJpeg(bytes));
    expect(error?.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(error?.message).toMatch(pattern);
    expect(error?.fix).toContain('convert in.jpg -interlace none baseline.jpg');
  });

  test.each([
    ['SOF9 arithmetic', jpegOf(frame(0xc9, 16, 16)), /SOF9/],
    ['SOF3 lossless', jpegOf(frame(0xc3, 16, 16)), /SOF3/],
    ['SOF11 arithmetic lossless', jpegOf(frame(0xcb, 16, 16)), /SOF11/],
    ['12-bit precision', jpegOf(frame(0xc0, 16, 16, 12)), /12-bit/],
    ['4-component CMYK', jpegOf(frame(0xc0, 16, 16, 8, 4)), /CMYK/],
  ])('refuses %s with a coded error', (_name, bytes, pattern) => {
    const error = failure(() => decodeJpeg(bytes));
    expect(error?.code).toBe('X_IMAGE_UNSUPPORTED');
    expect(error?.message).toMatch(pattern);
  });

  test('refuses bytes that are not a JPEG at all', () => {
    const error = failure(() => decodeJpeg(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])));
    expect(error?.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(error?.message).toMatch(/SOI/);
  });

  test('refuses a truncated scan rather than padding it with grey', () => {
    const bytes = fixtureBytes(JPEG_444_16X16);
    for (const cut of [40, 200, bytes.length - 60, bytes.length - 10]) {
      const error = failure(() => decodeJpeg(bytes.slice(0, cut)));
      expect(error?.code).toBe('X_IMAGE_DECODE_FAILED');
    }
  });

  test('refuses a scan that selects a Huffman table no DHT defined', () => {
    const error = failure(() =>
      decodeJpeg(jpegOf(DQT_FLAT, frame(0xc0, 8, 8), SOS_ONE_COMPONENT, [0x00, 0x00])),
    );
    expect(error?.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(error?.message).toMatch(/DC Huffman table 0/);
  });

  test('refuses a scan that selects a quantisation table no DQT defined', () => {
    const error = failure(() =>
      decodeJpeg(jpegOf(frame(0xc0, 8, 8), SOS_ONE_COMPONENT, [0x00, 0x00])),
    );
    expect(error?.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(error?.message).toMatch(/quantisation table 0/);
  });

  test('refuses a header that declares more pixels than the budget allows', () => {
    const error = failure(() => decodeJpeg(jpegOf(frame(0xc0, 30000, 30000))));
    expect(error?.code).toBe('X_IMAGE_TOO_LARGE');
    expect(error?.message).toMatch(/30000x30000/);
  });

  test('refuses a segment whose declared length runs past the file', () => {
    const error = failure(() => decodeJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x7f, 0xff])));
    expect(error?.code).toBe('X_IMAGE_DECODE_FAILED');
  });
});
