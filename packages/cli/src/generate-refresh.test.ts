// The rule `x g` decides its manifest refresh by: which written files can move a manifest fact.

import { describe, expect, test } from 'bun:test';
import { manifestCanChange } from './generate-refresh';

// Never read: every case is decided by its path, or by the planned bytes handed in.
const ROOT = '/nowhere/app';

describe('unit · manifestCanChange', () => {
  test('a module the app scan imports can', async () => {
    expect(await manifestCanChange(ROOT, ['apps/web/app/post/actions/publish.ts'])).toBe(true);
    expect(await manifestCanChange(ROOT, ['packages/db/src/client.ts'])).toBe(true);
  });

  test('a test, a stylesheet, a catalog and an island with no code cannot', async () => {
    const planned = new Map([['apps/web/app/glow/glow.island.tsx', 'export const Glow = 1;\n']]);
    const paths = [
      'apps/web/app/glow/glow.island.tsx',
      'apps/web/app/glow/glow.island.test.ts',
      'apps/web/app/glow/glow.module.scss',
      'packages/i18n/catalogs/en.json',
    ];
    expect(await manifestCanChange(ROOT, paths, planned)).toBe(false);
  });

  test('a file outside the scan that declares an X_ code can: the codes are a manifest fact', async () => {
    const planned = new Map([
      ['guards/no-foo.ts', "export const fail = { code: 'X_NO_FOO', cause: 'c', fix: 'x g' };\n"],
    ]);
    expect(await manifestCanChange(ROOT, ['guards/no-foo.ts'], planned)).toBe(true);
  });

  test('a source it cannot read, or a file at the app root, is answered as one that can', async () => {
    expect(await manifestCanChange(ROOT, ['guards/unread.ts'])).toBe(true);
    expect(await manifestCanChange(ROOT, ['app.config.ts'])).toBe(true);
    expect(await manifestCanChange(ROOT, [])).toBe(false);
  });
});
