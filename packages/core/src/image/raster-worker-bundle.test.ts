// Pins where `rasterWorkerBundle` says Bun embeds the worker: relative to the deepest directory
// every entrypoint shares, which is the root `/$bunfs/root/` resolves a `./` specifier from.

import { describe, expect, test } from 'bun:test';
// why: Bun has no path primitives; the expected values are built the way the bundle builds them.
import { dirname, join, relative, sep, win32 } from 'node:path';
import { isUltimateError } from '../errors';
import {
  RASTER_WORKER_DEFINE,
  RASTER_WORKER_ENTRY,
  rasterWorkerBundle,
  workerLayout,
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

  test('hands back the root it measured from, for Bun.build to be told rather than to infer', () => {
    const entry = join(dirname(RASTER_WORKER_ENTRY), 'entry.ts');
    expect(rasterWorkerBundle([entry]).root).toBe(dirname(RASTER_WORKER_ENTRY));
  });
});

// The Windows half, on any host: `win32` is Node's own Windows path flavour, which is what
// `node:path` IS on a Windows runner. CI's `windows-latest` builds from D:\a and its temp is on C:.
describe('workerLayout on Windows paths', () => {
  const worker = 'D:\\a\\ultimate\\packages\\core\\src\\image\\raster-worker.ts';

  test('an entry on the same drive roots at the shared directory, in forward slashes', () => {
    const layout = workerLayout(win32, ['D:\\a\\ultimate\\packages\\cli\\src\\bin.ts'], worker);
    expect(layout.root).toBe('D:\\a\\ultimate\\packages');
    expect(layout.define[RASTER_WORKER_DEFINE]).toBe(
      JSON.stringify('./core/src/image/raster-worker.ts'),
    );
  });

  test('sharing only the drive roots at the drive itself, never at "D:"', () => {
    const layout = workerLayout(win32, ['D:\\elsewhere\\entry.ts'], worker);
    expect(layout.root).toBe('D:\\');
    expect(layout.define[RASTER_WORKER_DEFINE]).toBe(
      JSON.stringify('./a/ultimate/packages/core/src/image/raster-worker.ts'),
    );
  });

  test('a drive letter in another case is the same drive', () => {
    expect(workerLayout(win32, ['d:\\a\\ultimate\\entry.ts'], worker).root).toBe('d:\\a\\ultimate');
  });

  test('another drive shares no directory: refused, coded, naming the move', () => {
    let caught: unknown;
    try {
      workerLayout(win32, ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\probe.ts'], worker);
    } catch (error) {
      caught = error;
    }
    if (!isUltimateError(caught)) return expect.unreachable('two drives were given a root');
    expect(caught.code).toBe('X_INVARIANT');
    expect(caught.fix).toContain('same drive');
  });
});
