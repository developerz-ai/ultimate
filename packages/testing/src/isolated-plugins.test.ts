// The per-file memory of an isolated `bun test` run. Bun 1.4.0 never frees a finished file's global
// object under `--isolate` (implied by `--parallel`, which `x test` uses) once ANY `Bun.plugin`
// load/resolve handler is registered — and the framework registers two in every file: the registry
// leak guard (preload) and render's `.tsx`/`.scss` loader. Measured on one adopter: 18 workers
// climbing ~100 MB → 2.1–2.3 GB each, about 57 MB per file. Both runs below are real `bun test`
// processes over a fixture corpus, because the leak is a property of the runner, not of a function.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
import { join } from 'node:path'; // why: Bun exposes no path API — nothing native joins a path.
import { clearPlugins, ISOLATED_ENV, releasePluginsAfterIsolatedFile } from './isolated-plugins';

// One root per PROCESS: two runs of this file share a checkout, and on one fixed root a peer's
// `rm` deleted this run's corpus mid-`bun test`.
const ROOT = join(import.meta.dir, '..', '.isolated-plugins-fixture', `run-${process.pid}`);
const PRELOAD = join(import.meta.dir, 'preload.ts');
const FILES = 8;

/**
 * Each file holds ~8 MB and reports the live global objects once collection has settled. A finished
 * file's global is not free after one `Bun.gc(true)`: the collection that finds the file dead hands
 * its release to a task on the NEXT event-loop turn; only a collection after that turn frees it.
 * On an idle machine an automatic collection mid-file usually got there first; on a loaded CI
 * runner it did not, and about one run in 80 read 3 (2026-10-09, run 37935896129). So: collect,
 * yield one turn, collect again, until the count stops falling. A retained file never falls, so
 * it still reads one global per file.
 */
const leaky = (i: number): string => `
import '@ultimat3/render/server';
import { afterAll, expect, test } from 'bun:test';
import { heapStats } from 'bun:jsc';
const ballast = new Array(1_000_000).fill(${i});
test('holds ballast ${i}', () => { expect(ballast.length).toBe(1_000_000); });
afterAll(async () => {
  let settled = Number.POSITIVE_INFINITY;
  for (;;) {
    Bun.gc(true);
    const live = heapStats().globalObjectCount;
    if (live >= settled) break;
    settled = live;
    await new Promise((turn) => setImmediate(turn));
  }
  console.log('GLOBALS=' + settled);
});
`;

const TSX = (name: string): string => `
import '@ultimat3/render/server';
import { isJsxNode } from '@ultimat3/render';
import { expect, test } from 'bun:test';
test('${name}', async () => {
  // Imported after the render loader is installed, as an app module is.
  const { Card } = await import('./card-${name}');
  expect(isJsxNode(Card({ label: '${name}' }))).toBe(true);
});
`;

const run = async (args: readonly string[], env: Record<string, string | undefined>) => {
  // Built key by key: a parent `x test` run sets the flag itself, and `undefined` must REMOVE it.
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...Bun.env, ...env })) {
    if (value !== undefined) merged[key] = value;
  }
  const child = Bun.spawn(['bun', 'test', ...args], {
    cwd: ROOT,
    env: merged,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, text: out + err };
};

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n`);
  for (let i = 0; i < FILES; i += 1) await Bun.write(join(ROOT, `leak-${i}.test.ts`), leaky(i));
  for (const name of ['a', 'b']) {
    await Bun.write(
      join(ROOT, `card-${name}.tsx`),
      'export const Card = (p: { label: string }) => <p>{p.label}</p>;\n',
    );
    await Bun.write(join(ROOT, `jsx-${name}.test.ts`), TSX(name));
  }
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('an isolated run frees each finished file', () => {
  test('live global objects stay flat across files, not one per file', async () => {
    const files = Array.from({ length: FILES }, (_, i) => `leak-${i}.test.ts`);
    const result = await run(['--parallel=1', ...files], { ULTIMATE_TEST_ISOLATED: '1' });
    expect(result.code).toBe(0);
    const counts = [...result.text.matchAll(/GLOBALS=(\d+)/g)].map((m) => Number(m[1]));
    expect(counts).toHaveLength(FILES);
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  }, 120_000);
});

describe('a shared run keeps its plugins', () => {
  // Cleared in a shared process, render's loader would stay `installed` with no plugin behind it,
  // and the next `.tsx` file would compile with Bun's classic factory: `__xh is not defined`.
  test('without the flag, a second .tsx file still compiles with the render loader', async () => {
    const result = await run(['jsx-a.test.ts', 'jsx-b.test.ts'], {
      ULTIMATE_TEST_ISOLATED: undefined,
    });
    expect(result.text).not.toContain('is not defined');
    expect(result.code).toBe(0);
  }, 120_000);
});

describe('releasePluginsAfterIsolatedFile', () => {
  test('hooks the clear only when the run says it is isolated', () => {
    const hooked: (() => void)[] = [];
    const after = (hook: () => void): void => void hooked.push(hook);
    let cleared = 0;
    // Never Bun's own registry here: this file may share its process with later ones.
    const plugin = {
      clearAll: (): void => {
        cleared += 1;
      },
    };
    expect(releasePluginsAfterIsolatedFile({}, after, plugin)).toBe(false);
    expect(releasePluginsAfterIsolatedFile({ [ISOLATED_ENV]: '0' }, after, plugin)).toBe(false);
    expect(hooked).toEqual([]);
    expect(releasePluginsAfterIsolatedFile({ [ISOLATED_ENV]: '1' }, after, plugin)).toBe(true);
    expect(hooked).toHaveLength(1);
    hooked[0]?.();
    expect(cleared).toBe(1);
  });

  // Never Bun's own here: this file may share its process with later ones in a serial run.
  test('clearPlugins empties the plugin registry it is handed', () => {
    let cleared = 0;
    clearPlugins({
      clearAll: () => {
        cleared += 1;
      },
    });
    expect(cleared).toBe(1);
  });
});

// `x test` sets the variable and this package's preload reads it: a second spelling on either side
// is a rename that compiles and silently turns the per-file release off.
//
// The scan reads the WHOLE framework's source (6,866 files, ~34 MB) and it is the one test here
// whose cost grows with every package the tree gains. It ran under Bun's 5 s default — the
// one-way rule broken for a number (#589) — and measured 3.6-4.4 s on an IDLE box, so it timed
// out on a runner with three workers on it:
//
//   (fail) ISOLATED_ENV is spelled once > no framework source outside isolated-plugins.ts writes
//          the name as a literal [5001.52ms]
//     ^ this test timed out after 5000ms.
//
// THIS FILE IS IN A CI JOB'S SLICE: the shard is a pure round-robin over the sorted unit file list
// (no `--timings` in CI), and this file is at unit index 2360 — 2360 % 3 === 2, the third shard.
// That job was red on the push of run 41714452760; the run's own log is not reachable from a
// developer box, so the failure above is the one MEASURED here, on the same slice, and the reason
// it belongs to this job.
//
// TWO fixes, both behaviour-preserving: the reads run in PARALLEL (the repo's own idiom for a
// tree walk, `scripts/primitive-factories.test.ts`), and the test carries the repo's whole-tree
// scan budget. The number is `REPO_SCAN_TIMEOUT_MS`'s, written as a literal because a published
// package's suite may not import the host monorepo's `scripts/`; `scripts/repo-scan-timeout.test.ts`
// compares them, so the mirror is a build error rather than a claim in a comment. The assertion
// is untouched: the same files are read and the same spelling is refused — a second spelling
// still fails it.
describe('ISOLATED_ENV is spelled once', () => {
  test('no framework source outside isolated-plugins.ts writes the name as a literal', async () => {
    const packages = join(import.meta.dir, '..', '..');
    const paths: string[] = [];
    for await (const path of new Bun.Glob('*/src/**/*.{ts,tsx}').scan({ cwd: packages })) {
      if (path.endsWith('.test.ts') || path === 'testing/src/isolated-plugins.ts') continue;
      paths.push(path);
    }
    const texts = await Promise.all(paths.map((path) => Bun.file(join(packages, path)).text()));
    const spelled = paths.filter((_, index) => (texts[index] ?? '').includes(`'${ISOLATED_ENV}'`));
    expect(spelled).toEqual([]);
  }, 180_000);
});
