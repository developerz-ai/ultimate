// What `X_NOT_IN_APP` tells a reader depends on where they stand: an app below is one `cd` away, and
// a project already on the framework must not be told to scaffold a second one.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { appDirsBelow, requireAppRoot } from './app-root';
import type { NotInAppError } from './errors';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tree = async (files: readonly string[], manifest?: string): Promise<string> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'x-app-root-')));
  dirs.push(dir);
  await Promise.all(files.map((path) => Bun.write(join(dir, path), '')));
  if (manifest !== undefined) await Bun.write(join(dir, 'package.json'), manifest);
  return dir;
};

const refusal = (from: string, command = 'upgrade'): NotInAppError => {
  try {
    requireAppRoot(command, from);
  } catch (error) {
    return error as NotInAppError;
  }
  return expect.unreachable('no app here, so this must refuse');
};

describe('unit · X_NOT_IN_APP', () => {
  test('an app below the cwd is named, and the fix is the cd', async () => {
    const dir = await tree(['apps/game/app.config.ts']);
    const error = refusal(dir);
    expect(error.code).toBe('X_NOT_IN_APP');
    expect(error.cause).toContain('apps/game');
    // Never a bare `x` (on no PATH) nor `bunx x` (with no node_modules, an unrelated npm package).
    expect(error.fix).toBe('cd apps/game && bunx @ultimat3/cli upgrade --json');
  });

  test('a root with its own `x` script is told to run it with --cwd, never a bare `x`', async () => {
    // The framework repo: `bun run x -- verify` at its root lands here, and `x` is on no PATH.
    const dir = await tree(
      ['examples/dummy/app.config.ts'],
      '{ "scripts": { "x": "bun run bin.ts" } }',
    );
    expect(refusal(dir, 'verify').fix).toBe('bun run x -- verify --cwd examples/dummy --json');
  });

  test('a two-word command pastes back as two arguments, not one quoted string', async () => {
    const dir = await tree(['web/app.config.ts']);
    expect(refusal(dir, 'vapid create').fix).toBe(
      'cd web && bunx @ultimat3/cli vapid create --json',
    );
  });

  test('a project on the framework with no config is not told to scaffold a second app', async () => {
    const dir = await tree([], '{ "dependencies": { "@ultimat3/core": "^19.0.0" } }');
    const error = refusal(dir);
    expect(error.cause).toContain('depends on @ultimat3/*');
    expect(error.fix).not.toStartWith('x new myapp');
    expect(error.fix).toContain('app.config.ts');
    expect(error.fix).toContain('x upgrade --json');
  });

  test('nothing here at all still says to start one', async () => {
    expect(refusal(await tree([])).fix).toBe('bunx create-ultimate myapp && cd myapp');
  });
});

describe('unit · appDirsBelow', () => {
  test('three levels down, sorted, never vendored, never deeper', async () => {
    const dir = await tree([
      'b/app.config.ts',
      'a/x/app.config.ts',
      'a/x/y/app.config.ts',
      'a/x/y/z/app.config.ts',
      'node_modules/pkg/app.config.ts',
    ]);
    expect(appDirsBelow(dir)).toEqual(['a/x', 'a/x/y', 'b']);
  });

  test('a directory that is not there answers none', () => {
    expect(appDirsBelow('/no/such/directory')).toEqual([]);
  });
});
