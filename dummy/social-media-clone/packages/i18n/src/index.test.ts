import { expect } from 'bun:test';
import { resolve } from 'node:path';
import { unitTest } from '@ultimat3/testing';
import { catalogs } from './index';

const ROOT = resolve(import.meta.dir, '../../..');

unitTest('every locale has the same keys as the default one', () => {
  const base = Object.keys(catalogs.catalogs[catalogs.default]).sort();
  for (const locale of catalogs.locales) {
    expect(Object.keys(catalogs.catalogs[locale]).sort()).toEqual(base);
  }
});

unitTest('no catalog value is empty', () => {
  for (const catalog of Object.values(catalogs.catalogs)) {
    for (const value of Object.values(catalog)) expect(value.length).toBeGreaterThan(0);
  }
});

/**
 * `t('...')`, and only the literal form: a key built from a variable is not knowable from source,
 * and a template with `${}` in it is a family this file cannot enumerate. The literals are the
 * overwhelming majority and they are the ones a rename silently breaks.
 */
const literalKeys = (source: string): readonly string[] =>
  [...source.matchAll(/\bt\(\s*['`]([A-Za-z0-9_.]+)['`]/g)].map((match) => match[1] ?? '');

unitTest('every literal key the app passes to t() exists in the catalog', async () => {
  const declared = new Set(Object.keys(catalogs.catalogs[catalogs.default]));
  // A plural family is stored as `key_one` / `key_other`, and the call site names the stem.
  const known = (key: string): boolean =>
    declared.has(key) || [...declared].some((entry) => entry.startsWith(`${key}_`));

  const missing: string[] = [];
  for await (const file of new Bun.Glob('{apps,packages}/**/*.{ts,tsx}').scan({ cwd: ROOT })) {
    // Shipped code only. A test may name a key that does not exist on purpose, and this file's
    // own doc comment above contains the literal `t('...')` it is looking for.
    if (file.includes('node_modules') || file.includes('.test.')) continue;
    const source = await Bun.file(resolve(ROOT, file)).text();
    for (const key of literalKeys(source)) {
      if (!known(key)) missing.push(`${key}  (${file})`);
    }
  }
  // A miss renders as `⟦key⟧` in the page and nothing fails — this is the failure.
  expect(missing).toEqual([]);
});
