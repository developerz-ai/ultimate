/**
 * Every module in this app loads against the real package APIs — in both senses, because they
 * fail differently:
 *
 * 1. it imports. The framework does most of its work at declaration time (`defineRoute`,
 *    `defineMail`, `defineAdmin`, `defineApi`, `entity()`), so a declaration the framework refuses
 *    throws on import and nowhere else.
 * 2. every name it imports is really exported. Bun's test runner links lazily, so a symbol the
 *    packages never shipped is silently `undefined` here and a hard error under `bun run` — which
 *    is how half this app once imported `defineCatalogs`, `rpc` and `<Text>` that did not exist.
 *
 * The module set is the framework's own, never this file's: `loadApp` is the scan `x dev`,
 * `x manifest` and `x verify` boot the app with, so a module that fails either half is a module the
 * toolchain cannot see. It was a `**\/*.{ts,tsx}` glob with a deny-list, and an entry-point
 * directory the list did not name (`bin/`) was imported — and RAN — before the list caught up.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isolateDeclaredTags } from '@ultimat3/cache';
import { loadApp } from '@ultimat3/cli';
import { Glob } from 'bun';

const APP_ROOT = Bun.fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');

/**
 * Importing every module of the app declares the app's cache tags — `packages/db/src/tags.ts` calls
 * `declareTags` at module scope — and `entity()` runs once per module, so the declaration cannot
 * happen twice. Left standing, this file's side effect decides what every later file in the same
 * `bun test` process validates tags against, which is state no reader of those files can see.
 */
const restoreTags = isolateDeclaredTags();
afterAll(restoreTags);

/** App-root-relative POSIX paths of the modules the boot imported, and what would not import. */
let booted: Awaited<ReturnType<typeof loadApp>>;
beforeAll(async () => {
  booted = await loadApp(APP_ROOT);
  // The whole module graph, imported once for every test below: it pays a real cost that grows
  // with the app, measured at a coin-flip against bun's 5000ms default while eight shards compete
  // for the same cores. A literal rather than `scripts/lib/run.ts`'s constant: an app's suite must
  // not import the host monorepo's scripts.
}, 30_000);

const absolute = (file: string): string => `${APP_ROOT}/${file}`;

/**
 * Every TypeScript source on disk, read as text and never imported — a test file is not a module
 * of the app, and `node_modules` is not this app's. Only the two text checks below read beyond
 * the boot set: the client entry points (`*.island.tsx`) the boot deliberately leaves to the
 * build are still this app's code, and reading a file runs nothing.
 */
const sources = async (): Promise<readonly string[]> => {
  const found: string[] = [];
  for await (const file of new Glob('**/*.{ts,tsx}').scan({ cwd: APP_ROOT })) {
    const posix = file.replaceAll('\\', '/');
    if (posix.split('/').includes('node_modules') || /\.test\.tsx?$/.test(posix)) continue;
    found.push(posix);
  }
  return found.sort();
};

const relative = (file: string): string => file.slice(APP_ROOT.length + 1);

/** The one module allowed to import `@ultimat3/i18n`: the one that registers the catalogs. */
const CATALOG_MODULE = 'packages/i18n/src/index.ts';

/**
 * `import { a, b as c } from 'x'` only. `import type { … }` is skipped because a type is not an
 * export at runtime, and `verbatimModuleSyntax` is on — so every *other* named import in this app
 * is a value import, which is what makes the check sound rather than approximate.
 */
const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g;

interface NamedImport {
  readonly specifier: string;
  readonly names: readonly string[];
}

const namedImportsOf = (source: string): readonly NamedImport[] => {
  const found: NamedImport[] = [];
  for (const match of source.matchAll(NAMED_IMPORT)) {
    if (match[1] !== undefined) continue;
    const names = (match[2] ?? '')
      .split(',')
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0 && !clause.startsWith('type '))
      .map((clause) => (clause.split(/\s+as\s+/)[0] ?? '').trim());
    if (names.length > 0) found.push({ specifier: match[3] ?? '', names });
  }
  return found;
};

describe('every app module', () => {
  test('imports against the real package APIs, as the boot imports it', () => {
    expect(booted.files.length).toBeGreaterThan(50);
    // A module that would not import, or a primitive that would not register, is a finding at
    // its file: the boot's own report, rendered one line each.
    expect(booted.findings.map((finding) => `${finding.at ?? '?'}: ${finding.cause}`)).toEqual([]);
  });

  // The boot is not the whole app: the island build's client entry points and the e2e suites'
  // fixtures are modules of this app too, and each must import against the real package APIs.
  // Every source on disk but the `bin/` entry points, which are scripts — importing one RUNS it.
  test('every other source module imports against the real package APIs', async () => {
    const rest = (await sources()).filter(
      (file) => !file.startsWith('bin/') && !booted.files.includes(file),
    );
    expect(rest.some((file) => /\.island\.tsx$/.test(file))).toBe(true);
    const failed: string[] = [];
    for (const file of rest) {
      try {
        await import(absolute(file));
      } catch (error) {
        failed.push(`${file}: ${String((error as Error).message).split('\n')[0]}`);
      }
    }
    expect(failed).toEqual([]);
  });

  // `bin/setup.ts` and `bin/check.ts` are what `bun run setup` / `check` execute: importing one
  // RUNS it (an install, `x setup`, a nested `x verify`). Present on disk, absent from the boot.
  test('runs no entry point: nothing under bin/ is in the set the boot imports', async () => {
    expect((await sources()).filter((file) => file.startsWith('bin/')).length).toBeGreaterThan(0);
    expect(booted.files.filter((file) => file.startsWith('bin/'))).toEqual([]);
  });

  test('imports only names those packages actually export', async () => {
    const files = (await sources()).map(absolute);
    const missing: string[] = [];

    for (const file of files) {
      const source = await Bun.file(file).text();
      for (const { specifier, names } of namedImportsOf(source)) {
        let module: Record<string, unknown>;
        try {
          module = (await import(
            Bun.resolveSync(specifier, file.replace(/\/[^/]+$/, ''))
          )) as Record<string, unknown>;
        } catch (error) {
          missing.push(
            `${relative(file)}: '${specifier}' — ${String((error as Error).message).split('\n')[0]}`,
          );
          continue;
        }
        for (const name of names) {
          if (name in module) continue;
          missing.push(`${relative(file)}: '${specifier}' exports no '${name}'`);
        }
      }
    }

    expect(missing).toEqual([]);
    // Resolves and imports every named-import target: the same whole-graph cost as the boot.
  }, 30_000);

  /**
   * Registration is a side effect of importing `packages/i18n/src/index.ts` — nothing else in this
   * app calls `defineCatalogs()`. A module that pulls `t` straight out of `@ultimat3/i18n` renders
   * strings while depending on nothing that registers them, which is exactly how a shipped app
   * served `⟦app.play.title⟧` on every page with `x verify` and `x i18n check` both green
   * (issue #249). `useT()` from `@postly/i18n` is the one way in, and it is typed against this
   * app's catalog besides, so an unknown key is a compile error rather than a loud miss.
   */
  test("reads strings through this app's catalog module, never past it", async () => {
    const files = (await sources()).map(absolute);
    const past: string[] = [];

    for (const file of files) {
      if (relative(file) === CATALOG_MODULE) continue;
      const source = await Bun.file(file).text();
      if (source.includes("from '@ultimat3/i18n'")) past.push(relative(file));
    }

    expect(past).toEqual([]);
  }, 30_000);
});
