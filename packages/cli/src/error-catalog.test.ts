// The catalog's only job is completeness, so the test that matters is the one that fails when a
// new package is added: the list is checked against the workspace on disk, not against itself.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { hasErrorCode } from '@ultimat3/core';
import { CATALOG_PACKAGES, loadErrorCatalog } from './error-catalog';

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
    expect([...catalog.loaded, ...catalog.unavailable].sort()).toEqual(
      [...CATALOG_PACKAGES].sort(),
    );
    // Anything unavailable must be a package on the list, never an invented name.
    for (const specifier of catalog.unavailable) {
      expect(CATALOG_PACKAGES).toContain(specifier as (typeof CATALOG_PACKAGES)[number]);
    }
  });

  test('is memoised — the registry is process-global, so once is enough', async () => {
    const first = loadErrorCatalog();
    expect(loadErrorCatalog()).toBe(first);
    await first;
  });
});
