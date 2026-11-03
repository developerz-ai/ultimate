// `defineError` is its own module so a browser chunk that only throws an `UltimateError` pays
// nothing for it. Measured on the artifact, as `page-bundle.test.ts` does: `Bun.build` with
// `minify: false` writes one `// <path>` banner per retained module, so the retained set is read
// off the chunk. A positive control proves the reading can see the module when it IS retained.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/core` resolves
// through the workspace, and each banner is resolved back to a path under `packages/`.
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `define-error-bytes-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

async function retained(name: string, source: string): Promise<readonly string[]> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, source);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${name} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const modules: string[] = [];
  for (const line of (await output.text()).split('\n')) {
    if (!line.startsWith('// ')) continue;
    const inside = relative(PACKAGES, resolve(process.cwd(), line.slice(3)));
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue;
    const module = inside.split(sep).join('/');
    if (module.startsWith('core/src/')) modules.push(module);
  }
  return modules;
}

const DEFINE_MODULES = ['core/src/define-error.ts', 'core/src/error-status-declared.ts'];

describe('the browser chunk that only throws UltimateError', () => {
  test('retains neither defineError nor the app status table', async () => {
    const modules = await retained(
      'throws',
      "import { UltimateError } from '@ultimat3/core';\n" +
        "globalThis.probe = new UltimateError({ code: 'X_A', cause: 'c', fix: 'x verify' });\n",
    );
    expect(modules).toContain('core/src/errors.ts');
    expect(modules.filter((module) => DEFINE_MODULES.includes(module))).toEqual([]);
  }, 60_000);

  test('a chunk that calls defineError retains both — the reading can see them', async () => {
    const modules = await retained(
      'defines',
      "import { defineError } from '@ultimat3/core';\n" +
        "globalThis.probe = defineError({ code: 'X_A', title: 't', status: 404, cause: 'c', fix: 'x' });\n",
    );
    expect(modules.filter((module) => DEFINE_MODULES.includes(module)).sort()).toEqual(
      DEFINE_MODULES,
    );
  }, 60_000);
});
