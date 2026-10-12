// `x g action` following a slice barrel on a real disk. The failure first: a relative
// `export * from './rules'` where `rules` is a DIRECTORY passed `existsSync`, and reading it as a
// file failed with an uncoded EISDIR.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory; the resolver under test reads a real one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: no Bun native answers the platform temp root.
import { join } from 'node:path'; // why: the sandbox's paths are joined, never concatenated.
import { followReexports } from './generate-reexports';
import { exportsUnknown, sliceExports } from './templates/slice-foundation';

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});
const slice = (): string => {
  root = mkdtempSync(join(tmpdir(), 'x-reexports-'));
  mkdirSync(join(root, 'apps/web/app/blog'), { recursive: true });
  return root;
};
const BARREL = "export * from './rules';\n";

describe('unit · a slice barrel is followed on disk, one level', () => {
  test('a directory with an index.ts is read through its index, as the resolver would', async () => {
    const dir = slice();
    mkdirSync(join(dir, 'apps/web/app/blog/rules'));
    writeFileSync(
      join(dir, 'apps/web/app/blog/rules/index.ts'),
      'export const canBlogWrite = 1;\n',
    );
    const source = await followReexports(dir, 'apps/web/app/blog', BARREL);
    expect(sliceExports(source ?? '', 'canBlogWrite')).toBe(true);
  });

  test('a directory with no index.ts cannot be followed — unknown, never an EISDIR', async () => {
    const dir = slice();
    mkdirSync(join(dir, 'apps/web/app/blog/rules'));
    const source = await followReexports(dir, 'apps/web/app/blog', BARREL);
    expect(exportsUnknown(source ?? '')).toBe(true);
  });
});
