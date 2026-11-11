// Pins where `rasterWorkerBundle` says Bun embeds the worker: relative to the deepest directory
// every entrypoint shares, which is the root `/$bunfs/root/` resolves a `./` specifier from.

import { describe, expect, test } from 'bun:test';
// why: Bun has no path primitives; the expected values are built the way the bundle builds them.
import { dirname, join, relative, sep } from 'node:path';
import {
  RASTER_WORKER_DEFINE,
  RASTER_WORKER_ENTRY,
  rasterWorkerBundle,
} from './raster-worker-bundle';

const posix = (path: string): string => path.split(sep).join('/');

describe('rasterWorkerBundle', () => {
  test('adds the worker file as the extra entrypoint', () => {
    expect(rasterWorkerBundle(['/somewhere/entry.ts']).entrypoint).toBe(RASTER_WORKER_ENTRY);
    expect(RASTER_WORKER_ENTRY.endsWith(join('image', 'raster-worker.ts'))).toBe(true);
  });

  test('an entry beside the worker roots the bundle there', () => {
    const entry = join(dirname(RASTER_WORKER_ENTRY), 'entry.ts');
    expect(rasterWorkerBundle([entry]).define).toEqual({
      [RASTER_WORKER_DEFINE]: JSON.stringify('./raster-worker.ts'),
    });
  });

  test("the x CLI's entry roots it at the deepest directory both share", () => {
    const packages = dirname(dirname(dirname(dirname(RASTER_WORKER_ENTRY))));
    const entry = join(packages, 'cli', 'src', 'bin.ts');
    expect(rasterWorkerBundle([entry]).define).toEqual({
      [RASTER_WORKER_DEFINE]: JSON.stringify(`./${posix(relative(packages, RASTER_WORKER_ENTRY))}`),
    });
  });

  test('a shared prefix that is not a whole directory name is not shared', () => {
    const image = dirname(RASTER_WORKER_ENTRY);
    const sibling = `${image}x${sep}entry.ts`;
    const define = rasterWorkerBundle([sibling]).define[RASTER_WORKER_DEFINE];
    expect(define).toBe(JSON.stringify('./image/raster-worker.ts'));
  });
});
