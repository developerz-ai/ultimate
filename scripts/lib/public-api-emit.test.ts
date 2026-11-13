// A package's entries as `exports` names them: the main entry, a subpath, and one entry per file
// a `./x/*` family matches, its specifier the key with the matched stem in place of `*`.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path'; // why: Bun ships no path API.
import { packageEntries } from './public-api-emit';

describe('public-api-emit · packageEntries', () => {
  test('a family is one entry per matched file; non-TypeScript targets are not entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'public-api-emit-'));
    try {
      const exports = {
        '.': './src/index.ts',
        './outbound': './src/outbound.ts',
        './icons/*': './src/icons/*.tsx',
        './styles.css': './src/styles.css',
      };
      await Bun.write(join(root, 'packages/ui/package.json'), JSON.stringify({ exports }));
      for (const file of ['index.ts', 'outbound.ts', 'icons/a-b.tsx', 'icons/c.tsx', 'styles.css'])
        await Bun.write(join(root, 'packages/ui/src', file), '');
      const entries = await packageEntries(root, { name: '@ultimat3/ui', dir: 'ui' });
      expect(entries).toEqual([
        { specifier: '@ultimat3/ui', source: 'packages/ui/src/index.ts' },
        { specifier: '@ultimat3/ui/icons/a-b', source: 'packages/ui/src/icons/a-b.tsx' },
        { specifier: '@ultimat3/ui/icons/c', source: 'packages/ui/src/icons/c.tsx' },
        { specifier: '@ultimat3/ui/outbound', source: 'packages/ui/src/outbound.ts' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
