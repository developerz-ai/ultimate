// Soundness of `selectTests`, the way it can actually fail: on a small app, break each module in
// turn, run EVERY test for real, and require every test that failed to be one the selection named.
// A test the closure missed is a green run over a broken app — the one answer `--affected` may
// never give. The app carries each edge kind: a re-export, a type-only import, a preload.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { moduleFiles, selectTests } from './app-module-graph';

const APP: Readonly<Record<string, string>> = {
  'bunfig.toml': '[test]\npreload = ["./scripts/setup.ts"]\n',
  'scripts/setup.ts': "import { SETUP } from '../packages/core/src/setup-value';\nvoid SETUP;\n",
  'packages/core/src/setup-value.ts': 'export const SETUP = 1;\n',
  'packages/core/src/money.ts': 'export const cents = (n: number): number => n * 100;\n',
  'packages/core/src/index.ts': "export { cents } from './money';\n",
  'apps/web/app/posts/entity.ts':
    'export interface Post { readonly id: string }\nexport const POSTS = 2;\n',
  'apps/web/app/posts/query.ts':
    "import type { Post } from './entity';\nimport { POSTS } from './entity';\nexport const count = (): number => POSTS;\nexport const first = (p: Post): string => p.id;\n",
  'apps/web/app/posts/query.test.ts':
    "import { expect, test } from 'bun:test';\nimport { count } from './query';\ntest('count', () => expect(count()).toBe(2));\n",
  'apps/web/app/billing/price.ts':
    "import { cents } from '../../../../packages/core/src/index';\nexport const price = (): number => cents(3);\n",
  'apps/web/app/billing/price.test.ts':
    "import { expect, test } from 'bun:test';\nimport { price } from './price';\ntest('price', () => expect(price()).toBe(300));\n",
  'apps/web/app/billing/alone.test.ts':
    "import { expect, test } from 'bun:test';\ntest('alone', () => expect(1).toBe(1));\n",
};

const root = await mkdtemp(join(tmpdir(), 'x-affected-closure-'));
afterAll(() => rm(root, { recursive: true, force: true }));
for (const [path, text] of Object.entries(APP)) await Bun.write(join(root, path), text);

const TESTS = Object.keys(APP).filter((path) => path.endsWith('.test.ts'));

/** The test files `bun test` reports failing, each run in its own process. */
function failing(): readonly string[] {
  return TESTS.filter((path) => {
    const run = Bun.spawnSync(['bun', 'test', `./${path}`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    return run.exitCode !== 0;
  });
}

describe('unit · --affected soundness', () => {
  test('nothing fails before a module is broken', () => {
    expect(failing()).toEqual([]);
  });

  const modules = Object.keys(APP).filter(
    (path) => /\.ts$/.test(path) && !path.endsWith('.test.ts'),
  );
  for (const module of modules) {
    test(`breaking ${module} fails only tests the selection names`, async () => {
      const original = APP[module] ?? '';
      await Bun.write(
        join(root, module),
        `${original}\nthrow new TypeError('broken by the soundness test');\n`,
      );
      try {
        const broke = failing();
        const selected = selectTests(await moduleFiles(root), [module]);
        expect(broke.filter((path) => !selected.tests.includes(path))).toEqual([]);
        expect(broke.length).toBeGreaterThan(0);
      } finally {
        await Bun.write(join(root, module), original);
      }
    });
  }

  test('a one-slice edit leaves the other slice out', async () => {
    const selected = selectTests(await moduleFiles(root), ['apps/web/app/posts/entity.ts']);
    expect(selected.tests).toEqual(['apps/web/app/posts/query.test.ts']);
  });
});
