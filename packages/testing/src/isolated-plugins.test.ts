// The per-file memory of an isolated `bun test` run. Bun 1.4.0 never frees a finished file's global
// object under `--isolate` (implied by `--parallel`, which `x test` uses) once ANY `Bun.plugin`
// load/resolve handler is registered — and the framework registers two in every file: the registry
// leak guard (preload) and render's `.tsx`/`.scss` loader. Measured on notificado.co: 18 workers
// climbing ~100 MB → 2.1–2.3 GB each, about 57 MB per file. Both runs below are real `bun test`
// processes over a fixture corpus, because the leak is a property of the runner, not of a function.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
import { join } from 'node:path'; // why: Bun exposes no path API — nothing native joins a path.

const ROOT = join(import.meta.dir, '..', '.isolated-plugins-fixture');
const PRELOAD = join(import.meta.dir, 'preload.ts');
const FILES = 8;

/** Each file holds ~8 MB and reports the live global objects once its own work is collected. */
const leaky = (i: number): string => `
import '@ultimat3/render/server';
import { afterAll, expect, test } from 'bun:test';
import { heapStats } from 'bun:jsc';
const ballast = new Array(1_000_000).fill(${i});
test('holds ballast ${i}', () => { expect(ballast.length).toBe(1_000_000); });
afterAll(() => { Bun.gc(true); console.log('GLOBALS=' + heapStats().globalObjectCount); });
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
  const child = Bun.spawn(['bun', 'test', ...args], {
    cwd: ROOT,
    env: { ...Bun.env, ...env },
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
