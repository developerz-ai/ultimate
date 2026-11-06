// `x test --affected` in an app root: the discovered files narrowed to `selectTests`' answer, and
// the reason each one runs. Real files on disk, because the import graph is read off them.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; each scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { appTestScope, narrowToApp } from './affected-tests';

const APP: Readonly<Record<string, string>> = {
  'app.config.ts': 'export const config = {};\n',
  'apps/web/app/posts/entity.ts': 'export const POSTS = 2;\n',
  'apps/web/app/posts/entity.test.ts': "import { POSTS } from './entity';\nvoid POSTS;\n",
  'apps/web/app/billing/price.ts': 'export const price = 3;\n',
  'apps/web/app/billing/price.test.ts': "import { price } from './price';\nvoid price;\n",
  // Outside every glob the module graph reads: it cannot say what this imports.
  'tests/smoke.test.ts': 'export {};\n',
};

const root = await mkdtemp(join(tmpdir(), 'x-affected-tests-'));
afterAll(() => rm(root, { recursive: true, force: true }));
for (const [path, text] of Object.entries(APP)) await Bun.write(join(root, path), text);

const discovered = (prefix: string): readonly { readonly path: string }[] =>
  Object.keys(APP)
    .filter((path) => path.endsWith('.test.ts') && path.startsWith(prefix))
    .map((path) => ({ path: path.slice(prefix.length) }));

describe('unit · appTestScope', () => {
  test('outside an app it answers nothing, so the workspace scope stands', async () => {
    expect(await appTestScope(tmpdir(), tmpdir(), ['a.ts'])).toBeUndefined();
  });

  test('a one-slice edit keeps that slice, drops the other, and keeps what the graph cannot see', async () => {
    const scope = await appTestScope(root, root, ['apps/web/app/posts/entity.ts']);
    if (scope === undefined) return expect.unreachable('the scratch app has an app.config.ts');
    const narrowed = narrowToApp(discovered(''), root, scope);
    expect(narrowed.kept.map((file) => file.path)).toEqual([
      'apps/web/app/posts/entity.test.ts',
      'tests/smoke.test.ts',
    ]);
    expect(narrowed.json).toEqual({
      app: root,
      all: false,
      reason: 'closure: 1 changed file(s)',
      forcing: [],
      files: [
        { path: 'apps/web/app/posts/entity.test.ts', why: 'closure' },
        { path: 'tests/smoke.test.ts', why: 'unmapped' },
      ],
    });
  });

  test('a file read rather than imported runs every discovered test, and says why', async () => {
    const scope = await appTestScope(root, root, ['app.config.ts']);
    if (scope === undefined) return expect.unreachable('the scratch app has an app.config.ts');
    const narrowed = narrowToApp(discovered(''), root, scope);
    expect(narrowed.kept).toEqual(discovered(''));
    expect(narrowed.json).toMatchObject({ all: true, reason: 'all: app.config.ts' });
  });

  test('from a directory inside the app, diff paths and discovered paths both line up', async () => {
    const web = join(root, 'apps/web');
    const scope = await appTestScope(web, root, ['apps/web/app/billing/price.ts']);
    if (scope === undefined) return expect.unreachable('apps/web sits inside the scratch app');
    const narrowed = narrowToApp(discovered('apps/web/'), web, scope);
    expect(narrowed.kept.map((file) => file.path)).toEqual(['app/billing/price.test.ts']);
  });

  test('a diff from a checkout above the app is re-rooted onto the app', async () => {
    const checkout = join(root, '..');
    const inside = `${root.slice(checkout.length + 1)}/apps/web/app/billing/price.ts`;
    const scope = await appTestScope(root, checkout, [inside]);
    if (scope === undefined) return expect.unreachable('the scratch app has an app.config.ts');
    expect(scope.tests).toEqual(['apps/web/app/billing/price.test.ts']);
  });
});
