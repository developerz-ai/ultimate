import { describe, expect, test } from 'bun:test';
import { createRaster, decodeImage, encodeImage, probeImage } from '@ultimat3/core';
import { NotImplementedError, PwaIconMissingError } from './errors';
import {
  BuiltinImagePipeline,
  ICON_MATRIX,
  MASKABLE_PADDING,
  maskableSafeZone,
  planIcons,
} from './icons';

function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

type Rgba = readonly [number, number, number, number];

const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const TRANSPARENT: Rgba = [0, 0, 0, 0];
/** `#0f2a44` — the pipeline takes hex or `transparent`, so the RGB is assertable exactly. */
const BACKGROUND = '#0f2a44';
const BACKGROUND_RGBA: Rgba = [15, 42, 68, 255];

/**
 * A red field with a blue block over the middle half. Two tones, not one: a solid image
 * would pass the geometry assertions even if the scaler centred the artwork wrongly.
 */
function sourceIcon(size = 1024): Uint8Array {
  const raster = createRaster(size, size, 'test source icon');
  const from = size / 4;
  const to = size - from;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const middle = x >= from && x < to && y >= from && y < to;
      raster.pixels[i] = middle ? 0 : 255;
      raster.pixels[i + 2] = middle ? 255 : 0;
      raster.pixels[i + 3] = 255;
    }
  }
  return encodeImage(raster, 'png');
}

/** Encoded once: every case reads the same bytes, which is also what makes determinism testable. */
const SOURCE = sourceIcon();

function pixelReader(bytes: Uint8Array): (x: number, y: number) => Rgba {
  const raster = decodeImage(bytes);
  return (x, y) => {
    const i = (y * raster.width + x) * 4;
    return [
      raster.pixels[i] ?? -1,
      raster.pixels[i + 1] ?? -1,
      raster.pixels[i + 2] ?? -1,
      raster.pixels[i + 3] ?? -1,
    ];
  };
}

/**
 * A `Promise`-typed method that throws synchronously walks straight past the caller's
 * `.catch()`, so the failure mode is asserted apart from the code.
 */
async function rejectionCode(call: () => Promise<unknown>): Promise<string> {
  let pending: Promise<unknown>;
  try {
    pending = call();
  } catch {
    return 'threw synchronously';
  }
  try {
    await pending;
    return 'resolved';
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'rejected without a code';
  }
}

describe('icon matrix', () => {
  test('covers maskable and apple touch icons, and maskables carry padding', () => {
    expect(ICON_MATRIX.some((spec) => spec.purpose === 'maskable' && spec.size === 512)).toBe(true);
    expect(ICON_MATRIX.some((spec) => spec.purpose === 'apple-touch' && spec.size === 180)).toBe(
      true,
    );
    expect(
      ICON_MATRIX.every((spec) => (spec.purpose === 'maskable' ? spec.padding > 0 : true)),
    ).toBe(true);
  });

  test('the maskable safe zone reserves 10% per edge', () => {
    expect(maskableSafeZone(512)).toEqual({ padding: 51, inner: 410 });
    expect(maskableSafeZone(192)).toEqual({ padding: 19, inner: 154 });
  });
});

describe('planIcons', () => {
  test('a missing source icon reports a fix, not a stack trace', () => {
    let fix = '';
    try {
      planIcons({});
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('assets/icon.png');
    expect(() => planIcons({})).toThrow(PwaIconMissingError);
  });

  test('derives every output from one source icon', () => {
    const plan = planIcons({ sourceIcon: 'assets/icon.png', outDir: '/icons' });
    expect(plan.source).toBe('assets/icon.png');
    expect(plan.entries.length).toBe(ICON_MATRIX.length);
    // apple touch icons are <link> tags, never manifest members
    expect(plan.manifestIcons.length).toBe(
      ICON_MATRIX.filter((spec) => spec.purpose !== 'apple-touch').length,
    );
    expect(plan.manifestIcons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    expect(plan.entries[0]?.outputPath).toBe('/icons/icon-48.png');
  });
});

describe('BuiltinImagePipeline', () => {
  const pipeline = new BuiltinImagePipeline();

  test('every matrix entry becomes a square PNG of exactly its declared size', async () => {
    for (const spec of ICON_MATRIX) {
      const bytes = await pipeline.resize(SOURCE, { size: spec.size, padding: spec.padding });
      // the manifest declares image/png for every one of these; anything else is a lie
      expect(probeImage(bytes)).toEqual({
        format: 'png',
        width: spec.size,
        height: spec.size,
        mimeType: 'image/png',
      });
    }
  });

  test("a plan entry's transform feeds the pipeline unchanged", async () => {
    const plan = planIcons({ sourceIcon: 'assets/icon.png', background: BACKGROUND });
    const maskable = plan.entries.find(
      (entry) => entry.spec.purpose === 'maskable' && entry.spec.size === 512,
    );
    expect(maskable?.transform).toEqual({
      size: 512,
      padding: MASKABLE_PADDING,
      background: BACKGROUND,
    });
    const bytes = await pipeline.resize(SOURCE, maskable?.transform ?? { size: 512, padding: 0 });
    expect(probeImage(bytes).width).toBe(512);
  });

  test('maskable padding leaves the artwork inside the safe zone and the ring background', async () => {
    const size = 192;
    const zone = maskableSafeZone(size);
    const at = pixelReader(
      await pipeline.resize(SOURCE, {
        size,
        padding: MASKABLE_PADDING,
        background: BACKGROUND,
      }),
    );

    // the ring outside the safe zone is background on all four corners
    const corners: readonly (readonly [number, number])[] = [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ];
    for (const [x, y] of corners) {
      expect(at(x, y)).toEqual(BACKGROUND_RGBA);
    }

    // the artwork starts exactly at the safe zone and ends exactly at its last pixel
    const last = zone.padding + zone.inner - 1;
    expect(at(zone.padding - 1, zone.padding - 1)).toEqual(BACKGROUND_RGBA);
    expect(at(zone.padding, zone.padding)).toEqual(RED);
    expect(at(last, last)).toEqual(RED);
    expect(at(last + 1, last + 1)).toEqual(BACKGROUND_RGBA);

    // and the artwork is scaled, not cropped: the middle block is still in the middle
    expect(at(size / 2, size / 2)).toEqual(BLUE);
  });

  test('no padding fills the canvas edge to edge', async () => {
    const at = pixelReader(await pipeline.resize(SOURCE, { size: 152, padding: 0 }));
    expect(at(0, 0)).toEqual(RED);
    expect(at(76, 76)).toEqual(BLUE);
  });

  test('the default background is transparent; an opaque one is exactly the hex asked for', async () => {
    const clear = pixelReader(
      await pipeline.resize(SOURCE, { size: 192, padding: MASKABLE_PADDING }),
    );
    expect(clear(0, 0)).toEqual(TRANSPARENT);
    expect(clear(191, 191)).toEqual(TRANSPARENT);

    const opaque = pixelReader(
      await pipeline.resize(SOURCE, {
        size: 192,
        padding: MASKABLE_PADDING,
        background: BACKGROUND,
      }),
    );
    expect(opaque(0, 0)).toEqual(BACKGROUND_RGBA);
  });

  test('the same input twice returns byte-identical output', async () => {
    const transform = { size: 192, padding: MASKABLE_PADDING, background: BACKGROUND };
    const first = await pipeline.resize(SOURCE, transform);
    const second = await pipeline.resize(SOURCE, transform);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  test('bytes that are no image reject, and never throw synchronously', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(await rejectionCode(() => pipeline.resize(garbage, { size: 512, padding: 0 }))).toBe(
      'X_IMAGE_UNSUPPORTED',
    );
    expect(
      await rejectionCode(() => pipeline.resize(new Uint8Array(), { size: 512, padding: 0 })),
    ).toBe('X_IMAGE_UNSUPPORTED');
  });

  test('a truncated PNG rejects as a decode failure, not as an unknown format', async () => {
    const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    expect(await rejectionCode(() => pipeline.resize(truncated, { size: 192, padding: 0 }))).toBe(
      'X_IMAGE_DECODE_FAILED',
    );
  });

  test('a named colour rejects — the background grammar is hex or transparent', async () => {
    expect(
      await rejectionCode(() =>
        pipeline.resize(SOURCE, { size: 192, padding: 0, background: 'red' }),
      ),
    ).toBe('X_IMAGE_UNSUPPORTED');
  });
});

/**
 * `NotImplementedError` is part of this package's declared error vocabulary and is exported,
 * but the icon driver — its only caller until now — is implemented. This keeps the contract
 * of a public export asserted; the package has no `errors.test.ts` to hold it.
 */
describe('pwa error vocabulary', () => {
  test('NotImplementedError still carries its code and an executable fix', () => {
    const error = new NotImplementedError(
      'the redis precache driver has no remote half',
      'x pwa build --driver=local',
    );
    expect(error.code).toBe('X_NOT_IMPLEMENTED');
    expect(fixOf(error)).toBe('x pwa build --driver=local');
  });
});
