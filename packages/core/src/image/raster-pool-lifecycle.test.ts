// Pins the raster pool's edges: the caller's bytes survive the hand-off whatever view they are, a
// Worker that goes away settles what it owed, and one that loaded but crashed is not "no Worker".

import { afterAll, describe, expect, test } from 'bun:test';
// why: the reported bug is a Node Buffer from readFileSync; Bun has no mkdtemp or recursive remove.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '../errors';
import { encodeImage } from './png-pixels';
import { blankRaster } from './raster';
import { type RasterPool, rasterPool } from './raster-pool';
import { transformInline } from './transform-inline';

const WORKER_URL = new URL('./raster-worker.ts', import.meta.url).href;
const SOURCE = encodeImage(blankRaster(40, 30));
const SPEC = { width: 20, format: 'png' } as const;

const pools: RasterPool[] = [];
function pool(spawn: () => Worker): RasterPool {
  const made = rasterPool({ spawn, role: () => 'worker' });
  pools.push(made);
  return made;
}
const dir = mkdtempSync(join(tmpdir(), 'ultimate-raster-pool-'));
afterAll(() => {
  for (const one of pools) one.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A Worker from inline source: announces itself as the real one does, then does `onRequest`. */
function scripted(onRequest: string): Worker {
  const source = `postMessage({ ready: true });\naddEventListener('message', () => { ${onRequest} });`;
  return new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (caught) {
    return caught;
  }
  return expect.unreachable('the transform resolved where it had to reject');
}

describe("the caller's bytes", () => {
  test('a Buffer from readFileSync is intact after the call, and transforms again', async () => {
    const file = join(dir, 'source.png');
    await Bun.write(file, new Uint8Array(SOURCE));
    const buffer = readFileSync(file);
    const viaWorker = pool(() => new Worker(WORKER_URL));
    const golden = await transformInline(SOURCE, SPEC);
    expect(await viaWorker.transform(buffer, SPEC)).toEqual(golden);
    expect(buffer.byteLength).toBe(SOURCE.byteLength);
    expect(await viaWorker.transform(buffer, SPEC)).toEqual(golden);
  });

  test('a view into a bigger buffer hands over the view only, and keeps the parent', async () => {
    const parent = new Uint8Array(SOURCE.length + 64).fill(7);
    parent.set(SOURCE, 32);
    const view = parent.subarray(32, 32 + SOURCE.length);
    const viaWorker = pool(() => new Worker(WORKER_URL));
    expect(await viaWorker.transform(view, SPEC)).toEqual(await transformInline(SOURCE, SPEC));
    expect(parent.byteLength).toBe(SOURCE.length + 64);
    expect(parent[0]).toBe(7);
    expect(view).toEqual(new Uint8Array(SOURCE));
  });
});

describe('a Worker that goes away', () => {
  test('exiting without an error event rejects what it owed, coded', async () => {
    const exits = pool(() => scripted('process.exit(0);'));
    const caught = await rejection(exits.transform(SOURCE, SPEC));
    expect(isUltimateError(caught) ? caught.code : 'not coded').toBe('X_INTERNAL');
  });

  test('close() with a request pending rejects it rather than leaving it forever', async () => {
    const silent = pool(() => scripted('/* never answers */'));
    // Closed while the request is still in flight: the Worker never answers, so it stays owed.
    const owed = silent.transform(SOURCE, SPEC);
    silent.close();
    const caught = await rejection(owed);
    expect(isUltimateError(caught) ? caught.code : 'not coded').toBe('X_INTERNAL');
  });

  test('a Worker that LOADED and crashed on its first request is replaced, not abandoned', async () => {
    let spawned = 0;
    const crashesOnce = pool(() => {
      spawned += 1;
      return spawned === 1 ? scripted("throw new TypeError('boom');") : new Worker(WORKER_URL);
    });
    const caught = await rejection(crashesOnce.transform(SOURCE, SPEC));
    expect(isUltimateError(caught) ? caught.code : 'not coded').toBe('X_INTERNAL');
    // The next transform starts a NEW Worker — never the inline path a broken load deserves.
    expect(await crashesOnce.transform(SOURCE, SPEC)).toEqual(await transformInline(SOURCE, SPEC));
    expect(spawned).toBe(2);
  });
});
