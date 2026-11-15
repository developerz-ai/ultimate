// A built-in guard's module on disk: one file per guard per installed text, written atomically —
// parallel calls in one process both succeed — and nothing left behind: no temp file, and no
// module an older install wrote for the same guard.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { materializeGuard } from './guards-materialize';
import { shippedGuardSource } from './templates/scaffold-guards';

const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-guard-materialize-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const cached = async (root: string): Promise<readonly string[]> =>
  [...new Bun.Glob('*').scanSync({ cwd: join(root, '.x/cache/guards') })].sort();

describe('unit · a built-in guard materialized', () => {
  test('two parallel calls for one guard both answer the module, and leave no temp file', async () => {
    await withRoot(async (root) => {
      const paths = await Promise.all([
        materializeGuard(root, 'raw-fetch'),
        materializeGuard(root, 'raw-fetch'),
        materializeGuard(root, 'raw-fetch'),
      ]);
      expect(new Set(paths).size).toBe(1);
      expect(await Bun.file(paths[0] ?? '').text()).toBe(shippedGuardSource('raw-fetch') ?? '');
      expect((await cached(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  test("an older install's module for the same guard is removed; another guard's is kept", async () => {
    await withRoot(async (root) => {
      const dir = join(root, '.x/cache/guards');
      await Bun.write(join(dir, 'raw-fetch-oldhash.ts'), 'export {};\n');
      await Bun.write(join(dir, 'raw-fetch-extra-oldhash.ts'), 'export {};\n');
      const path = await materializeGuard(root, 'raw-fetch');
      expect(await cached(root)).toEqual(
        [path.split('/').pop() ?? '', 'raw-fetch-extra-oldhash.ts'].sort(),
      );
    });
  });
});
