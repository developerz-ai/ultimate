// The finding this exists for, end to end with real git and the real CLI: two branches each run
// `x g resource`, and the merge needs no hand edit. Only a genuine disagreement stays a conflict.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no directory or symlink API.
import { mkdirSync, symlinkSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { TempTree } from '@ultimat3/testing';
import { tempTree } from '@ultimat3/testing';

const BIN = join(import.meta.dir, 'bin.ts');
const REGISTRIES = [
  'apps/web/api/index.ts',
  'apps/web/exercise.ts',
  'apps/web/shared/roles.ts',
  'packages/db/src/client.ts',
  'packages/i18n/catalogs/en.json',
];
const PROJECTIONS = ['x.manifest.json', 'openapi.json'];

let tree: TempTree | undefined;
let app = '';

const run = (argv: readonly string[]): { code: number; out: string } => {
  const done = Bun.spawnSync([...argv], {
    cwd: app,
    // git discovery stops at the tree, and its background maintenance stays off.
    env: { ...Bun.env, ...tree?.gitEnv },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  return { code: done.exitCode, out: `${done.stdout.toString()}${done.stderr.toString()}` };
};
const must = (argv: readonly string[]): string => {
  const { code, out } = run(argv);
  if (code !== 0) expect.unreachable(`${argv.join(' ')} exited ${code}: ${out}`);
  return out;
};
const git = (...args: string[]): string => must(['git', ...args]);
const x = (...args: string[]): string => must([process.execPath, BIN, ...args]);
const read = (path: string): Promise<string> => Bun.file(join(app, path)).text();
const unmerged = (): string => git('diff', '--name-only', '--diff-filter=U').trim();

const commitAll = (message: string): void => {
  git('add', '-A');
  git('commit', '-qm', message);
};

/**
 * A feature on its own branch, as one agent would produce it. The projections are written after
 * `x g`, which would otherwise refresh them by loading an app this fixture never installed.
 */
const feature = async (name: string): Promise<void> => {
  git('checkout', '-q', '-b', name, 'main');
  x('g', 'resource', name);
  for (const path of PROJECTIONS) await Bun.write(join(app, path), `{"feature":"${name}"}\n`);
  commitAll(name);
};

beforeAll(async () => {
  tree = tempTree('merge-features-');
  const parent = tree.path;
  const created = Bun.spawnSync([process.execPath, BIN, 'new', 'demo', '--dir', parent], {
    env: { ...Bun.env, ...tree.gitEnv },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  });
  if (created.exitCode !== 0) expect.unreachable(`x new: ${created.stderr.toString()}`);
  app = join(parent, 'demo');
  mkdirSync(join(app, 'node_modules/.bin'), { recursive: true });
  symlinkSync(BIN, join(app, 'node_modules/.bin/x'));
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'rerere.enabled', 'false');
  git('branch', '-M', 'main');
  await Bun.write(join(app, '.git/info/exclude'), 'node_modules\n');
  x('merge-driver', 'install');
  await feature('alpha');
  await feature('beta');
}, 120_000);

afterAll(async () => {
  await tree?.dispose();
});

describe('unit · two generated features, one merge', () => {
  let first: readonly string[] = [];

  test('beta merges alpha with no conflict and keeps both features in every registry', async () => {
    git('checkout', '-q', '-B', 'one', 'alpha');
    git('merge', '--no-edit', 'beta');
    expect(unmerged()).toBe('');
    first = await Promise.all(REGISTRIES.map(read));
    for (const [index, path] of REGISTRIES.entries()) {
      expect(first[index], path).not.toContain('<<<<<<<');
      if (path === 'apps/web/exercise.ts') continue;
      expect(first[index], path).toMatch(/alpha/);
      expect(first[index], path).toMatch(/beta/);
    }
    expect(first[0]).toContain("import * as createAlpha from '../app/alpha/actions/create-alpha';");
    expect(first[0]).toContain("import * as createBeta from '../app/beta/actions/create-beta';");
    expect(JSON.parse(first[4] as string)).toMatchObject({ admin: { alphas: {}, betas: {} } });
  }, 30_000);

  test('the other direction writes the same bytes', async () => {
    expect(first).toHaveLength(REGISTRIES.length);
    git('checkout', '-q', '-B', 'other', 'beta');
    git('merge', '--no-edit', 'alpha');
    expect(unmerged()).toBe('');
    expect(await Promise.all(REGISTRIES.map(read))).toEqual([...first]);
  }, 30_000);

  test('the projections keep our side, for x manifest to rebuild', async () => {
    git('checkout', '-q', '-B', 'projected', 'alpha');
    git('merge', '--no-edit', 'beta');
    expect(await read('x.manifest.json')).toBe('{"feature":"alpha"}\n');
  }, 30_000);

  test('both branches rewriting one grant is still a conflict, and is told as one', async () => {
    const ROLES = 'apps/web/shared/roles.ts';
    const edit = async (branch: string, grant: string): Promise<void> => {
      git('checkout', '-q', '-B', branch, 'main');
      const source = await read(ROLES);
      await Bun.write(join(app, ROLES), source.replace("'post:read',", `'${grant}',`));
      commitAll(branch);
    };
    await edit('left', 'post:left');
    await edit('right', 'post:right');
    git('checkout', '-q', 'left');
    const merge = run(['git', 'merge', '--no-edit', 'right']);
    expect(merge.code).not.toBe(0);
    expect(merge.out).toContain('X_MERGE_UNRESOLVED');
    expect(unmerged()).toBe(ROLES);
    const held = await read(ROLES);
    expect(held).toContain('<<<<<<< ours');
    expect(held).toContain("'post:left'");
    expect(held).toContain("'post:right'");
    git('merge', '--abort');
  }, 30_000);
});
