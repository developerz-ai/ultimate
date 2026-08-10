// The catalog's only job is completeness, so the test that matters is the one that fails when a
// new package is added: the list is checked against the workspace on disk, not against itself.

import { describe, expect, test } from 'bun:test';
// `node:` by necessity: Bun exposes no path-join primitive. `import.meta.dir` gives the directory
// this file is in, and joining the repo root onto it still needs `node:path`.
import { join } from 'node:path';
import { hasErrorCode } from '@ultimat3/core';
import { buildErrorCatalog, CATALOG_PACKAGES, loadErrorCatalog } from './error-catalog';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/** Every workspace package that declares codes — `cli` excluded, it registers its own. */
async function packagesWithErrorCodes(): Promise<readonly string[]> {
  const found: string[] = [];
  for await (const path of new Bun.Glob('packages/*/src/errors.ts').scan({ cwd: REPO_ROOT })) {
    const name = path.split('/')[1] ?? '';
    if (name !== 'cli' && name.length > 0) found.push(`@ultimat3/${name}`);
  }
  return found.sort();
}

describe('unit · the catalog list', () => {
  test('covers every workspace package that owns error codes', async () => {
    const expected = await packagesWithErrorCodes();
    expect([...CATALOG_PACKAGES].sort()).toEqual([...expected]);
  });

  test('never names a package twice — a duplicate import is a silent no-op', () => {
    expect(new Set(CATALOG_PACKAGES).size).toBe(CATALOG_PACKAGES.length);
  });

  test('excludes the CLI itself, whose errors.ts registers at import', () => {
    expect(CATALOG_PACKAGES).not.toContain('@ultimat3/cli');
  });
});

describe('unit · loading it', () => {
  test('registers codes the CLI graph never imports on its own', async () => {
    await loadErrorCatalog();
    // auth, pwa and money are reachable from no `x` command, so only the catalog puts them here.
    expect(hasErrorCode('X_UNAUTHENTICATED')).toBe(true);
    expect(hasErrorCode('X_PWA_ICON_MISSING')).toBe(true);
    expect(hasErrorCode('X_CURRENCY_UNKNOWN')).toBe(true);
  });

  test('reports what it could not import rather than dropping it silently', async () => {
    const catalog = await loadErrorCatalog();
    const seen = [...catalog.loaded, ...catalog.unavailable, ...catalog.failed.map((f) => f.at)];
    expect(seen.sort()).toEqual([...CATALOG_PACKAGES].sort());
    // Anything unavailable must be a package on the list, never an invented name.
    for (const specifier of catalog.unavailable) {
      expect(CATALOG_PACKAGES).toContain(specifier as (typeof CATALOG_PACKAGES)[number]);
    }
  });

  // Not a formality: an initialization failure here is a real package defect — a duplicate code, a
  // registration the registry refuses — and the old catch-everything reported it as a missing
  // module, so `x errors` answered from a partial table with no cause and nothing to run.
  test('no framework package fails to initialize in this repo', async () => {
    expect((await loadErrorCatalog()).failed).toEqual([]);
  });

  test('is memoised — the registry is process-global, so once is enough', async () => {
    const first = loadErrorCatalog();
    expect(loadErrorCatalog()).toBe(first);
    await first;
  });
});

describe('unit · a package that will not load', () => {
  const loaderFailing = (target: string, thrown: unknown) => async (specifier: string) => {
    if (specifier === target) throw thrown;
    return {};
  };

  // The shape Bun raises for `@ultimat3/ui`, whose JSX runtime a bare CLI process does not have.
  const unresolved = { code: 'ERR_MODULE_NOT_FOUND', message: "Cannot find module 'react/jsx'" };

  test('an unresolvable module is the documented host gap, not a defect', async () => {
    const catalog = await buildErrorCatalog(loaderFailing('@ultimat3/ui', unresolved));
    expect(catalog.unavailable).toEqual(['@ultimat3/ui']);
    expect(catalog.failed).toEqual([]);
    expect(catalog.loaded).not.toContain('@ultimat3/ui');
  });

  test('a package that throws while initializing keeps its code, cause and fix', async () => {
    const duplicate = {
      code: 'X_ERROR_CODE_DUPLICATE',
      cause: 'already registered: X_DB_DRIFT',
      fix: "rename the colliding code in the registering package's src/errors.ts",
    };
    const catalog = await buildErrorCatalog(loaderFailing('@ultimat3/db', duplicate));
    expect(catalog.unavailable).toEqual([]);
    expect(catalog.failed).toEqual([
      {
        code: 'X_ERROR_CODE_DUPLICATE',
        cause: '@ultimat3/db failed to initialize: already registered: X_DB_DRIFT',
        fix: "rename the colliding code in the registering package's src/errors.ts",
        at: '@ultimat3/db',
      },
    ]);
  });

  test('an unstructured throw still names the package that broke', async () => {
    const catalog = await buildErrorCatalog(loaderFailing('@ultimat3/mail', new Error('boom')));
    const [finding] = catalog.failed;
    expect(finding?.at).toBe('@ultimat3/mail');
    expect(finding?.cause).toBe('@ultimat3/mail failed to initialize: boom');
    expect(finding?.fix.length).toBeGreaterThan(0);
  });

  test('every package still lands in exactly one bucket', async () => {
    const catalog = await buildErrorCatalog(loaderFailing('@ultimat3/db', new Error('boom')));
    const seen = [...catalog.loaded, ...catalog.unavailable, ...catalog.failed.map((f) => f.at)];
    expect(seen.sort()).toEqual([...CATALOG_PACKAGES].sort());
  });
});
