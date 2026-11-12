// Pins the raster Worker: the same bytes as the inline transform, the event loop free while it
// works, coded errors arriving as their own class, the inline fallback, and the web role's budget.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '../errors';
import { installLogSink } from '../logger';
import { ImageDecodeFailedError, ImageRasterBudgetError } from './errors';
import { transformImageBytes } from './pipeline';
import { encodeImage } from './png-pixels';
import { rasterFrom } from './raster';
import { RASTER_SYNC_PIXELS, type RasterPool, rasterPool } from './raster-pool';
import { type ImageTransformSpec, transformInline } from './transform-inline';

const WORKER_URL = new URL('./raster-worker.ts', import.meta.url).href;

/** A gradient with a ramp in every channel, so a resampler that moved a pixel changes a byte. */
function gradient(width: number, height: number): Uint8Array {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      pixels[at] = (x * 255) / width;
      pixels[at + 1] = (y * 255) / height;
      pixels[at + 2] = ((x + y) * 127) / (width + height);
      pixels[at + 3] = 200 + (x % 56);
    }
  }
  return encodeImage(rasterFrom(width, height, pixels));
}

const pools: RasterPool[] = [];
function pool(spawn: () => Worker, role: 'web' | 'worker' = 'web'): RasterPool {
  const made = rasterPool({ spawn, role: () => role });
  pools.push(made);
  return made;
}
afterAll(() => {
  for (const one of pools) one.close();
});

const noWorker = (): Worker => {
  throw new ImageDecodeFailedError('stand-in: no Worker here', 'none');
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (caught) {
    return caught;
  }
  return expect.unreachable('the transform resolved where it had to refuse');
}

/** The worst gap a 1 ms timer saw while `work` ran: how long the event loop was blocked. */
async function worstGap(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  // real-clock: a probe, not a wait — it measures this loop while the Worker's thread works.
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  last = performance.now();
  await work();
  clearInterval(timer);
  return worst;
}

const SPECS: readonly (readonly [string, ImageTransformSpec])[] = [
  ['a plain resize', { width: 48, format: 'png' }],
  [
    'a padded contain (the canvas hop)',
    { width: 40, height: 40, padding: 0.1, background: '#f00' },
  ],
  ['an upscaling cover (the crop hop)', { width: 300, height: 40, fit: 'cover', format: 'png' }],
  ['webp at a quality', { width: 30, format: 'webp', quality: 70 }],
  ['jpeg', { format: 'jpeg' }],
];

describe('the raster Worker', () => {
  const source = gradient(96, 64);

  test.each(SPECS)('answers %s with the inline bytes, byte for byte', async (_label, spec) => {
    let spawned = 0;
    const viaWorker = pool(() => {
      spawned += 1;
      return new Worker(WORKER_URL);
    });
    const golden = await transformInline(source, spec);
    expect(await viaWorker.transform(source, spec)).toEqual(golden);
    expect(await transformImageBytes(source, spec)).toEqual(golden);
    expect(spawned).toBe(1);
  });

  test('concurrent transforms each get their own answer', async () => {
    const viaWorker = pool(() => new Worker(WORKER_URL));
    const [a, b] = await Promise.all([
      viaWorker.transform(source, { width: 20, format: 'png' }),
      viaWorker.transform(source, { width: 50, format: 'png' }),
    ]);
    expect(a).toEqual(await transformInline(source, { width: 20, format: 'png' }));
    expect(b).toEqual(await transformInline(source, { width: 50, format: 'png' }));
  });

  test('a coded refusal arrives as its own class, with its code, cause and fix', async () => {
    const caught = await rejection(transformImageBytes(source.subarray(0, 60)));
    expect(caught).toBeInstanceOf(ImageDecodeFailedError);
    if (!isUltimateError(caught)) return expect.unreachable('the refusal was not coded');
    expect(caught.code).toBe('X_IMAGE_DECODE_FAILED');
    expect(caught.fix.length).toBeGreaterThan(0);
    const quality = await rejection(transformImageBytes(source, { quality: Number.NaN }));
    expect(isUltimateError(quality) ? quality.code : 'not coded').toBe('X_INVARIANT');
  });

  test('keeps the event loop free where the inline hops block it', async () => {
    // 4096², the plan's measurement: inline, the canvas hop blocked the loop 98-1,945 ms.
    const big = gradient(4096, 4096);
    // A 4096x2048 letterbox: 2048² of art inflated and 8.4 MP of canvas deflated.
    const spec: ImageTransformSpec = { width: 4096, height: 2048, fit: 'contain' };
    // The PUBLIC function, so a `transformImageBytes` that stopped reaching the Worker fails here.
    await transformImageBytes(source, { width: 8 }); // the Worker's start-up is not the transform
    // Worker first: the inline run leaves hundreds of MB of rasters behind, and their collection
    // landing in the Worker's window measured the collector, not the Worker (50.1 ms, once).
    const workerGap = await worstGap(() => transformImageBytes(big, spec));
    const inlineGap = await worstGap(() => transformInline(big, spec));
    expect(workerGap).toBeLessThan(50);
    expect(inlineGap).toBeGreaterThan(workerGap * 2);
  }, 30_000);
});

describe('where no Worker can start', () => {
  test('says so ONCE, at warn, with the reason — production never degrades silently', async () => {
    const lines: string[] = [];
    const release = installLogSink((line) => lines.push(line));
    try {
      const inline = pool(noWorker, 'worker');
      await inline.transform(gradient(16, 16), { width: 8 });
      await inline.transform(gradient(16, 16), { width: 4 });
    } finally {
      release();
    }
    const said = lines.filter((line) => line.includes('image.raster_worker_unavailable'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"level":"warn"');
    expect(said[0]).toContain('stand-in: no Worker here');
  });

  test('runs inline, with the same bytes', async () => {
    const source = gradient(96, 64);
    const spec: ImageTransformSpec = { width: 40, height: 40, fit: 'contain' };
    expect(await pool(noWorker, 'worker').transform(source, spec)).toEqual(
      await transformInline(source, spec),
    );
  });

  test('a Worker that never loads hands what was waiting to the inline path', async () => {
    const source = gradient(32, 32);
    const missing = pool(
      () => new Worker(new URL('./no-such-raster-worker.ts', import.meta.url).href),
      'worker',
    );
    expect(await missing.transform(source, { width: 16 })).toEqual(
      await transformInline(source, { width: 16 }),
    );
  });

  test('the web role refuses a raster hop over its budget, naming the warm-up job', async () => {
    // A contain into a 1000x500 canvas: 500² of art inflated + 500,000 canvas pixels deflated.
    expect(500 * 500 + 1000 * 500).toBeGreaterThan(RASTER_SYNC_PIXELS);
    const caught = await rejection(
      pool(noWorker, 'web').transform(gradient(1000, 1000), { width: 1000, height: 500 }),
    );
    expect(caught).toBeInstanceOf(ImageRasterBudgetError);
    if (!isUltimateError(caught)) return expect.unreachable('the refusal was not coded');
    expect(caught.code).toBe('X_IMAGE_RASTER_BUDGET');
    expect(caught.fix).toContain('packages/storage/src/image-warm.ts');
  });

  test('the web role still runs a plain resize, and a raster hop under the budget', async () => {
    const web = pool(noWorker, 'web');
    expect((await web.transform(gradient(1000, 1000), { width: 900 })).length).toBeGreaterThan(0);
    const small = gradient(200, 100);
    expect(await web.transform(small, { width: 50, height: 50 })).toEqual(
      await transformInline(small, { width: 50, height: 50 }),
    );
  });

  test('any other role runs the same hop inline, unbudgeted', async () => {
    const bytes = await pool(noWorker, 'worker').transform(gradient(1000, 1000), {
      width: 1000,
      height: 500,
    });
    expect(bytes.length).toBeGreaterThan(0);
  });
});
