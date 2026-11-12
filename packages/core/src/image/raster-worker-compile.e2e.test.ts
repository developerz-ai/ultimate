// Compiles a script that calls `transformImageBytes` into a real single-file executable with Bun
// bundling core, and runs it as the web role: with `rasterWorkerBundle()` the Worker starts inside
// the executable and answers the inline bytes; without it the fallback is said aloud and budgeted.
//
//   bun test ./packages/core/src/image/raster-worker-compile.e2e.test.ts

import { afterAll, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no path-join primitive; Bun.build takes the paths already joined.
import { join } from 'node:path';
import { rasterWorkerBundle } from './raster-worker-bundle';

// Under the repository, never the OS temp: on `windows-latest` the checkout is on D: and the temp
// on C:, and entrypoints on two drives share no directory for the build to root at.
const scratch = join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '.cache');
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, 'ultimate-raster-worker-e2e-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const own = (file: string): string => JSON.stringify(join(import.meta.dir, file));

/**
 * Counts `new Worker(…)` through the global the pool reads at the call, captures the log, then
 * answers one cover 1200x630 of a 2048² PNG — the shape of every OG card — beside the inline bytes.
 */
const PROBE = `import { installLogSink } from ${own('../logger.ts')};
import { transformImageBytes } from ${own('pipeline.ts')};
import { encodeImage } from ${own('png-pixels.ts')};
import { rasterFrom } from ${own('raster.ts')};
import { transformInline } from ${own('transform-inline.ts')};
let spawned = 0;
const Real = globalThis.Worker;
globalThis.Worker = class extends Real {
  constructor(...args) { super(...args); spawned += 1; }
};
const lines = [];
installLogSink((line) => lines.push(line));
const side = 2048;
const pixels = new Uint8ClampedArray(side * side * 4);
for (let i = 0; i < pixels.length; i += 4) {
  pixels[i] = (i >> 5) & 255; pixels[i + 1] = (i >> 13) & 255; pixels[i + 3] = 255;
}
const source = encodeImage(rasterFrom(side, side, pixels));
const spec = { width: 1200, height: 630, fit: 'cover', format: 'png' };
let code = 'none';
let same = false;
try {
  const viaPool = await transformImageBytes(source, spec);
  const inline = await transformInline(source, spec);
  same = viaPool.length === inline.length && viaPool.every((byte, i) => byte === inline[i]);
} catch (error) {
  code = error.code ?? 'uncoded';
}
// The warning's own reason, so a red run says WHY the Worker never answered.
const warning = lines.find((l) => l.includes('image.raster_worker_unavailable'));
const reason = warning === undefined ? null : JSON.parse(warning).reason ?? 'no reason field';
console.log(JSON.stringify({ spawned, code, same, reason }));
`;

async function compileAndRun(name: string, withWorker: boolean): Promise<Record<string, unknown>> {
  const entry = join(dir, `${name}.ts`);
  const outfile = join(dir, name);
  await Bun.write(entry, PROBE);
  const bundle = rasterWorkerBundle([entry]);
  const built = await Bun.build({
    entrypoints: withWorker ? [entry, bundle.entrypoint] : [entry],
    compile: { outfile },
    // The root the define is relative to, stated: what `compileExecutable` passes too.
    root: bundle.root,
    define: withWorker ? { ...bundle.define } : {},
    throw: false,
  });
  expect(built.logs.map(String)).toEqual([]);
  expect(built.success).toBe(true);
  const run = Bun.spawn([outfile], {
    cwd: dir,
    env: { ...process.env, ROLE: 'web' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exit] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  expect(exit).toBe(0);
  const last = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(last) as Record<string, unknown>;
}

test('compiled with rasterWorkerBundle, the Worker starts and answers the inline bytes', async () => {
  expect(await compileAndRun('with-worker', true)).toEqual({
    spawned: 1,
    code: 'none',
    same: true,
    reason: null,
  });
}, 120_000);

test('compiled without it, the fallback is said aloud and the web role holds its budget', async () => {
  expect(await compileAndRun('without-worker', false)).toEqual({
    spawned: 0,
    code: 'X_IMAGE_RASTER_BUDGET',
    same: false,
    reason: expect.stringContaining('compiled without the raster worker entrypoint'),
  });
}, 120_000);
