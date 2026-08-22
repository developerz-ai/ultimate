// `frameworkScopeDir` decides which framework `x docs` reads and which `fix:` lines
// `x errors explain` projects, so "how many packages does it see" is the only assertion that
// matters here — a scope directory that resolves and holds one package is the failure this file
// exists to catch, and it is indistinguishable from a working one until something globs it.
//
// The fixtures are real `node_modules` trees with real symlinks: Bun's resolver is what is under
// test, and a mocked one would test the mock.

import { describe, expect, test } from 'bun:test';
// `node:fs` — Bun has no temp-directory, symlink or realpath API; `node:path` — no path joiner.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { frameworkScopeDir } from './framework-scope';

/** Every package a scope directory offers to the two callers, which glob one level down. */
async function packagesUnder(scope: string): Promise<readonly string[]> {
  const names = new Set<string>();
  const walk = new Bun.Glob('*/src/**/*.ts').scan({ cwd: scope, followSymlinks: true });
  for await (const path of walk) {
    const name = path.split('/')[0];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

/** One published package, exactly as npm ships it: `exports` pointing at `src/index.ts`. */
async function writePackage(dir: string, name: string): Promise<void> {
  await Bun.write(
    join(dir, 'package.json'),
    `${JSON.stringify({
      name: `@ultimat3/${name}`,
      version: '7.0.0',
      type: 'module',
      exports: { '.': './src/index.ts' },
    })}\n`,
  );
  await Bun.write(join(dir, 'src', 'index.ts'), `export const ${name} = 1;\n`);
}

const FRAMEWORK = ['core', 'entity', 'http', 'jobs', 'render'] as const;

/** Bun's store directory, spelled once — the segment a corrected scope must no longer contain. */
const STORE_SEGMENT = '.bun';

/**
 * Bun's **isolated** layout: every package in its own store entry under `node_modules/.bun`, with
 * a symlink per installed package in `node_modules/@ultimat3`, and the CLI's own dependencies
 * linked beside it inside its store entry. That last link is the one the resolver follows, and
 * following it is what used to end the walk in a directory holding one package.
 */
async function isolatedApp(root: string): Promise<string> {
  const modules = join(root, 'node_modules');
  const store = join(modules, '.bun');
  mkdirSync(join(modules, '@ultimat3'), { recursive: true });
  for (const name of [...FRAMEWORK, 'cli']) {
    const dir = join(store, `@ultimat3+${name}@7.0.0`, 'node_modules', '@ultimat3', name);
    await writePackage(dir, name);
    symlinkSync(relative(join(modules, '@ultimat3'), dir), join(modules, '@ultimat3', name));
  }
  const cliDeps = join(store, '@ultimat3+cli@7.0.0', 'node_modules', '@ultimat3');
  const core = join(store, '@ultimat3+core@7.0.0', 'node_modules', '@ultimat3', 'core');
  symlinkSync(relative(cliDeps, core), join(cliDeps, 'core'));
  return join(store, '@ultimat3+cli@7.0.0', 'node_modules', '@ultimat3', 'cli', 'src');
}

/** The flat layout `bun install` produces by default: no store, every package at the scope root. */
async function hoistedApp(root: string): Promise<string> {
  const scope = join(root, 'node_modules', '@ultimat3');
  for (const name of [...FRAMEWORK, 'cli']) await writePackage(join(scope, name), name);
  return join(scope, 'cli', 'src');
}

type ScopeAssertions = (from: string) => void | Promise<void>;

/** Awaited, never fired and forgotten: the fixture is removed the moment this returns. */
async function withApp(
  build: (root: string) => Promise<string>,
  body: ScopeAssertions,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'x-scope-')));
  try {
    await body(await build(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('unit · the installed framework scope', () => {
  // Measured before the fix, on this exact fixture: the scope resolved to
  // `node_modules/.bun/@ultimat3+core@7.0.0/node_modules/@ultimat3` and offered `["core"]` — one
  // package of six, with no error anywhere, which is what let 400 of 405 codes answer
  // "nothing in the installed framework raises this" with `ok: true`.
  test("an isolated install offers every package, not the store entry's one", async () => {
    await withApp(isolatedApp, async (from) => {
      const scope = frameworkScopeDir(from);
      expect(scope).toBeDefined();
      expect(await packagesUnder(scope ?? '')).toEqual([
        'cli',
        'core',
        'entity',
        'http',
        'jobs',
        'render',
      ]);
    });
  });

  test("an isolated install resolves to the app's own scope, never into the store", async () => {
    await withApp(isolatedApp, (from) => {
      const scope = frameworkScopeDir(from) ?? '';
      expect(scope).not.toContain(STORE_SEGMENT);
      expect(scope.endsWith(join('node_modules', '@ultimat3'))).toBe(true);
    });
  });

  test('a hoisted install is already the scope directory and is left exactly as resolved', async () => {
    await withApp(hoistedApp, async (from) => {
      const scope = frameworkScopeDir(from);
      expect(scope).toBeDefined();
      expect(await packagesUnder(scope ?? '')).toEqual([
        'cli',
        'core',
        'entity',
        'http',
        'jobs',
        'render',
      ]);
    });
  });

  // The path this repo's own `x` takes, and the one every existing caller is pinned on: a
  // workspace checkout has no `node_modules/.bun` above `packages/`, so nothing is corrected.
  test('this checkout answers with packages/, which holds every framework package', async () => {
    const scope = frameworkScopeDir();
    expect(scope).toBe(join(import.meta.dir, '..', '..'));
    expect((await packagesUnder(scope ?? '')).length).toBeGreaterThan(20);
  });

  // A broken install is `undefined` and never a guess: every caller reports "the CLI cannot see
  // its own dependency", which is a different sentence from "the framework documents nothing".
  test('a base from which @ultimat3/core does not resolve is undefined', async () => {
    await withApp(
      async (root) => root,
      (from) => {
        expect(frameworkScopeDir(join(from, 'nowhere'))).toBeUndefined();
      },
    );
  });
});
