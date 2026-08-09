// Single responsibility: proving the baseline JPEG encoder emits a stream any conforming decoder
// reads — the exact segment sequence, stuffed entropy bytes, edge MCUs that do not darken, and a
// round trip whose error stays where 4:2:0 says it should.

import { describe, expect, test } from 'bun:test';
import { fixtureBytes, JPEG_420_16X16, jpegPixel } from './fixtures';
import { decodeJpeg } from './jpeg-decode';
import { encodeJpeg } from './jpeg-encode';
import { STD_LUMINANCE_QUANT, scaleQuantTable, ZIGZAG } from './jpeg-tables';
import { type Raster, rasterFrom } from './raster';

type Formula = (x: number, y: number) => readonly [number, number, number];

function rasterOf(width: number, height: number, formula: Formula, alpha = 255): Raster {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = formula(x, y);
      const i = (y * width + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = alpha;
    }
  }
  return rasterFrom(width, height, pixels);
}

function meanAbsoluteError(decoded: Raster, formula: Formula): number {
  let total = 0;
  let samples = 0;
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const expected = formula(x, y);
      const i = (y * decoded.width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        total += Math.abs((decoded.pixels[i + c] ?? 0) - (expected[c] ?? 0));
        samples += 1;
      }
    }
  }
  return total / samples;
}

interface Segment {
  readonly marker: number;
  readonly payload: Uint8Array;
}

interface ParsedJpeg {
  readonly markers: readonly number[];
  readonly segments: readonly Segment[];
  readonly entropyStart: number;
  readonly entropyEnd: number;
}

/** Walks the container the way a decoder does, so a wrong length or a missing stuff byte trips. */
function parseJpeg(bytes: Uint8Array): ParsedJpeg {
  const segments: Segment[] = [];
  let entropyStart = -1;
  let entropyEnd = -1;
  let i = 0;
  while (i + 1 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1] ?? 0;
    i += 2;
    if (marker === 0xd8 || marker === 0xd9) {
      segments.push({ marker, payload: new Uint8Array(0) });
      if (marker === 0xd9) break;
      continue;
    }
    const length = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
    segments.push({ marker, payload: bytes.subarray(i + 2, i + length) });
    i += length;
    if (marker === 0xda) {
      entropyStart = i;
      while (i < bytes.length && !(bytes[i] === 0xff && bytes[i + 1] !== 0x00)) {
        i += bytes[i] === 0xff ? 2 : 1;
      }
      entropyEnd = i;
    }
  }
  return { markers: segments.map((s) => s.marker), segments, entropyStart, entropyEnd };
}

const payloadOf = (parsed: ParsedJpeg, marker: number): Uint8Array =>
  parsed.segments.find((s) => s.marker === marker)?.payload ?? new Uint8Array(0);

const SOI = 0xd8;
const EOI = 0xd9;
const SOF0 = 0xc0;
const DHT = 0xc4;
const SOS = 0xda;
const DQT = 0xdb;
const APP0 = 0xe0;

describe('encodeJpeg container', () => {
  const bytes = encodeJpeg(rasterOf(37, 21, jpegPixel), 80);
  const parsed = parseJpeg(bytes);

  test('emits the baseline segment sequence, and nothing else', () => {
    expect(parsed.markers).toEqual([SOI, APP0, DQT, DQT, SOF0, DHT, DHT, DHT, DHT, SOS, EOI]);
  });

  test('APP0 is a JFIF 1.1 header with no thumbnail', () => {
    expect([...payloadOf(parsed, APP0)]).toEqual([
      0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    ]);
  });

  test('DQT carries both 8-bit tables in zig-zag order', () => {
    const tables = parsed.segments.filter((s) => s.marker === DQT).map((s) => s.payload);
    expect(tables.map((t) => t[0])).toEqual([0x00, 0x01]); // id 0/1, high nibble 0 == 8-bit
    expect(tables.every((t) => t.length === 65)).toBe(true);
    const luma = scaleQuantTable(STD_LUMINANCE_QUANT, 80);
    const zigzagged = Array.from({ length: 64 }, (_, k) => luma[ZIGZAG[k] ?? 0]);
    expect([...(tables[0] ?? new Uint8Array()).subarray(1)]).toEqual(zigzagged as number[]);
  });

  test('SOF0 declares the size, three components and 4:2:0 sampling', () => {
    const sof = payloadOf(parsed, SOF0);
    expect(sof[0]).toBe(8); // 8-bit precision
    expect(((sof[1] ?? 0) << 8) | (sof[2] ?? 0)).toBe(21); // height
    expect(((sof[3] ?? 0) << 8) | (sof[4] ?? 0)).toBe(37); // width
    expect(sof[5]).toBe(3);
    expect([...sof.subarray(6)]).toEqual([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  });

  test('DHT ships all four standard tables, DC and AC for both classes', () => {
    const tables = parsed.segments.filter((s) => s.marker === DHT);
    expect(tables.map((t) => t.payload[0])).toEqual([0x00, 0x10, 0x01, 0x11]);
    for (const { payload } of tables) {
      const counts = [...payload.subarray(1, 17)].reduce((a, b) => a + b, 0);
      expect(payload.length).toBe(17 + counts);
    }
  });

  test('SOS selects both Huffman classes over the whole spectral band', () => {
    expect([...payloadOf(parsed, SOS)]).toEqual([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  });

  test('every FF in the entropy stream is stuffed, and EOI closes it', () => {
    expect(parsed.entropyStart).toBeGreaterThan(0);
    expect(parsed.entropyEnd).toBeGreaterThan(parsed.entropyStart);
    for (let i = parsed.entropyStart; i < parsed.entropyEnd; i += 1) {
      if (bytes[i] === 0xff) expect(bytes[i + 1]).toBe(0x00);
    }
    expect(bytes[parsed.entropyEnd]).toBe(0xff);
    expect(bytes[parsed.entropyEnd + 1]).toBe(EOI);
    expect(bytes.length).toBe(parsed.entropyEnd + 2);
  });
});

describe('encodeJpeg round trip', () => {
  // 4:2:0 halves both chroma planes, so a source with a hard 240-level wrap in R and B — which
  // `jpegPixel` has at x=16 and at x+y=32 — cannot come back under ~6 through any encoder.
  // Measured through this same decoder: ours 6.29, the reference encoder's own 4:2:0 6.35.
  const TOLERANCE = 7;

  test('a 32x32 raster survives quality 92', () => {
    const decoded = decodeJpeg(encodeJpeg(rasterOf(32, 32, jpegPixel), 92));
    expect(decoded.width).toBe(32);
    expect(decoded.height).toBe(32);
    expect(meanAbsoluteError(decoded, jpegPixel)).toBeLessThan(TOLERANCE);
  });

  test('an odd 33x17 raster keeps its exact size through MCU padding', () => {
    const decoded = decodeJpeg(encodeJpeg(rasterOf(33, 17, jpegPixel), 92));
    expect(decoded.width).toBe(33);
    expect(decoded.height).toBe(17);
    expect(meanAbsoluteError(decoded, jpegPixel)).toBeLessThan(TOLERANCE);
  });

  test('the padded edge replicates instead of darkening', () => {
    // A flat mid-grey: any zero-filled MCU padding bleeds a dark rim back into the last real
    // column and row, which is exactly what a uniform source makes impossible to miss.
    const decoded = decodeJpeg(
      encodeJpeg(
        rasterOf(19, 19, () => [128, 128, 128]),
        90,
      ),
    );
    for (let y = 0; y < 19; y += 1) {
      for (let x = 0; x < 19; x += 1) {
        expect(decoded.pixels[(y * 19 + x) * 4]).toBeGreaterThan(120);
      }
    }
  });

  test('matches the reference encoder on the same pixels, size and error', () => {
    // `JPEG_420_16X16` is an external reference encoder's 4:2:0 quality-90 take on `jpegPixel`.
    // Both sides go through the same decoder here, so the comparison is about the encoder only.
    const reference = fixtureBytes(JPEG_420_16X16);
    const ours = encodeJpeg(rasterOf(16, 16, jpegPixel), 90);
    const referenceError = meanAbsoluteError(decodeJpeg(reference), jpegPixel);
    expect(meanAbsoluteError(decodeJpeg(ours), jpegPixel)).toBeLessThanOrEqual(
      referenceError + 0.15,
    );
    expect(ours.length).toBeLessThanOrEqual(Math.round(reference.length * 1.05));
  });

  test('a 1x1 raster encodes and decodes back to 1x1', () => {
    const decoded = decodeJpeg(
      encodeJpeg(
        rasterOf(1, 1, () => [200, 100, 50]),
        80,
      ),
    );
    expect([decoded.width, decoded.height]).toEqual([1, 1]);
    expect([...decoded.pixels]).toEqual([200, 100, 50, 255]);
  });
});

describe('encodeJpeg alpha', () => {
  test('a fully transparent raster composites to white, never to black', () => {
    const decoded = decodeJpeg(
      encodeJpeg(
        rasterOf(24, 24, () => [0, 0, 0], 0),
        90,
      ),
    );
    for (let i = 0; i < decoded.pixels.length; i += 4) {
      expect(decoded.pixels[i]).toBeGreaterThan(240);
      expect(decoded.pixels[i + 1]).toBeGreaterThan(240);
      expect(decoded.pixels[i + 2]).toBeGreaterThan(240);
      expect(decoded.pixels[i + 3]).toBe(255);
    }
  });

  test('a half-transparent black composites part way to white', () => {
    // 0*a + 255*(1-a) with a = 64/255 is 191: visibly grey, and unmistakably not 0.
    const decoded = decodeJpeg(
      encodeJpeg(
        rasterOf(24, 24, () => [0, 0, 0], 64),
        90,
      ),
    );
    expect(decoded.pixels[0] ?? 0).toBeGreaterThan(185);
    expect(decoded.pixels[0] ?? 0).toBeLessThan(197);
  });
});

describe('encodeJpeg quality', () => {
  const raster = rasterOf(32, 32, jpegPixel);

  test('a lower quality produces fewer bytes', () => {
    expect(encodeJpeg(raster, 30).length).toBeLessThan(encodeJpeg(raster, 95).length);
  });

  test('a higher quality round-trips with strictly less error', () => {
    const coarse = meanAbsoluteError(decodeJpeg(encodeJpeg(raster, 30)), jpegPixel);
    const fine = meanAbsoluteError(decodeJpeg(encodeJpeg(raster, 95)), jpegPixel);
    expect(fine).toBeLessThan(coarse);
  });

  test('quality is clamped to 1-100 rather than producing a broken table', () => {
    for (const quality of [-40, 0, 1, 100, 480, Number.NaN]) {
      const decoded = decodeJpeg(encodeJpeg(raster, quality));
      expect([decoded.width, decoded.height]).toEqual([32, 32]);
    }
    expect(encodeJpeg(raster, 480)).toEqual(encodeJpeg(raster, 100));
    expect(encodeJpeg(raster, -40)).toEqual(encodeJpeg(raster, 1));
  });

  test('the default quality is used when none is passed', () => {
    expect(encodeJpeg(raster)).toEqual(encodeJpeg(raster, 80));
  });
});

describe('encodeJpeg determinism', () => {
  test('the same raster and quality produce byte-identical output', () => {
    const raster = rasterOf(41, 29, jpegPixel);
    expect(encodeJpeg(raster, 77)).toEqual(encodeJpeg(raster, 77));
  });

  test('a different quality produces different bytes', () => {
    const raster = rasterOf(41, 29, jpegPixel);
    expect(encodeJpeg(raster, 77)).not.toEqual(encodeJpeg(raster, 78));
  });
});
