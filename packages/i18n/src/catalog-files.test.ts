// The split layout as data: a file's path is its key prefix, the files join into one catalog with
// each key owned by exactly one file, and a catalog partitions back into the same files.

import { describe, expect, test } from 'bun:test';
import { loadCatalog, nestCatalog } from './catalog';
import {
  catalogFileName,
  catalogFilePrefix,
  joinCatalogFiles,
  partitionCatalog,
} from './catalog-files';

const file = (name: string, value: unknown) => ({
  path: `packages/i18n/catalogs/en/${name}`,
  name,
  value,
});

/** The code a call throws, or `undefined` when it returns. */
function codeOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

describe('catalogFilePrefix', () => {
  test('a file stem and each directory are key segments', () => {
    expect(catalogFilePrefix('billing.json')).toBe('billing');
    expect(catalogFilePrefix('site/home.json')).toBe('site.home');
    expect(catalogFileName('site.home')).toBe('site/home.json');
  });

  test('a name that is not key segments is X_CATALOG_INVALID', () => {
    expect(codeOf(() => catalogFilePrefix('my namespace.json'))).toBe('X_CATALOG_INVALID');
    expect(codeOf(() => catalogFilePrefix('billing.txt'))).toBe('X_CATALOG_INVALID');
  });
});

describe('joinCatalogFiles', () => {
  test('each file is read under its prefix, nested folders included', () => {
    const joined = joinCatalogFiles([
      file('site/home.json', { title: 'Home' }),
      file('billing.json', { plans: { pro: 'Pro' } }),
      file('site.json', { footer: 'Footer' }),
    ]);
    expect({ ...joined }).toEqual({
      'billing.plans.pro': 'Pro',
      'site.footer': 'Footer',
      'site.home.title': 'Home',
    });
  });

  test('a key two files define is X_CATALOG_KEY_DUPLICATE naming both', () => {
    let cause = '';
    try {
      joinCatalogFiles([
        file('site.json', { home: { title: 'Home' } }),
        file('site/home.json', { title: 'Start' }),
      ]);
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe('X_CATALOG_KEY_DUPLICATE');
      cause = (error as { cause: string }).cause;
    }
    expect(cause).toContain('"site.home.title"');
    expect(cause).toContain('packages/i18n/catalogs/en/site.json');
    expect(cause).toContain('packages/i18n/catalogs/en/site/home.json');
  });

  test('a leaf one file defines and another nests under is a duplicate too', () => {
    const run = () =>
      joinCatalogFiles([file('site.json', { home: 'Home' }), file('site/home.json', { t: 'x' })]);
    expect(codeOf(run)).toBe('X_CATALOG_KEY_DUPLICATE');
  });

  test('a file that is not a catalog object is X_CATALOG_INVALID', () => {
    expect(codeOf(() => joinCatalogFiles([file('billing.json', 'Pro')]))).toBe('X_CATALOG_INVALID');
    expect(codeOf(() => joinCatalogFiles([file('billing.json', { n: 1 })]))).toBe(
      'X_CATALOG_INVALID',
    );
  });
});

describe('partitionCatalog', () => {
  const catalog = loadCatalog({
    billing: { plans: { pro: 'Pro' } },
    site: { footer: 'Footer', home: { title: 'Home' } },
  });

  test('one file per namespace, keys relative to it', () => {
    const parts = partitionCatalog(catalog);
    expect([...parts.keys()].sort()).toEqual(['billing.json', 'site.json']);
    expect({ ...parts.get('site.json') }).toEqual({ footer: 'Footer', 'home.title': 'Home' });
  });

  test('an existing nested file takes the keys under its prefix', () => {
    const parts = partitionCatalog(catalog, ['site.json', 'site/home.json']);
    expect({ ...parts.get('site/home.json') }).toEqual({ title: 'Home' });
    expect({ ...parts.get('site.json') }).toEqual({ footer: 'Footer' });
  });

  test('partition then join is the same catalog', () => {
    const parts = partitionCatalog(catalog, ['site/home.json']);
    const files = [...parts].map(([name, part]) => file(name, nestCatalog(part)));
    expect({ ...joinCatalogFiles(files) }).toEqual({ ...catalog });
  });

  test('a top-level leaf has no namespace file and is refused', () => {
    expect(codeOf(() => partitionCatalog(loadCatalog({ greeting: 'Hi' })))).toBe(
      'X_CATALOG_INVALID',
    );
  });
});
