// The real-filesystem `CodemodApp`: app-root relative posix paths in and out, directories made on
// write, a removal of nothing is no error, no path outside the root, no `node_modules` in a glob.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no recursive remove and no symlink.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { fsCodemodApp, landFile } from './engine-fs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-codemod-fs-'));
  dirs.push(dir);
  return dir;
};

describe('unit · codemod engine, the real filesystem', () => {
  test('reads, writes into new directories, removes, and says what exists', async () => {
    const dir = root();
    const app = fsCodemodApp(dir);
    expect(app.root).toBe(dir);
    expect(await app.read('a/b.ts')).toBeUndefined();
    await app.write('a/b.ts', 'x\n');
    expect(await Bun.file(join(dir, 'a/b.ts')).text()).toBe('x\n');
    expect(await app.exists('a/b.ts')).toBe(true);
    expect(await app.read('a/b.ts')).toBe('x\n');
    await app.remove('a/b.ts');
    expect(await app.exists('a/b.ts')).toBe(false);
    await app.remove('a/b.ts');
  });

  test('a write lands whole, through a temp file renamed over the target: none is left behind', async () => {
    const dir = root();
    const app = fsCodemodApp(dir);
    await app.write('a/b.ts', 'one\n');
    await app.write('a/b.ts', 'two\n');
    expect(await Bun.file(join(dir, 'a/b.ts')).text()).toBe('two\n');
    expect(await Array.fromAsync(new Bun.Glob('a/*').scan({ cwd: dir, dot: true }))).toEqual([
      'a/b.ts',
    ]);
  });

  test('a rename that fails leaves the old file whole and no temp file behind', async () => {
    const dir = root();
    await Bun.write(join(dir, 'a.json'), '{"old":true}\n');
    const failing = async (): Promise<void> => {
      throw new UltimateError({ code: 'X_PLANTED_FAILURE', cause: 'EXDEV', fix: 'x verify' });
    };
    await expect(landFile(join(dir, 'a.json'), '{"new":true}\n', failing)).rejects.toMatchObject({
      code: 'X_PLANTED_FAILURE',
    });
    expect(await Bun.file(join(dir, 'a.json')).text()).toBe('{"old":true}\n');
    expect(await Array.fromAsync(new Bun.Glob('*').scan({ cwd: dir, dot: true }))).toEqual([
      'a.json',
    ]);
  });

  test('a glob answers sorted posix paths, dot directories included, node_modules never', async () => {
    const dir = root();
    for (const path of ['.claude/settings.json', 'apps/web/a.ts', 'node_modules/x/a.ts', 'b.ts']) {
      await Bun.write(join(dir, path), '');
    }
    const app = fsCodemodApp(dir);
    expect(await app.glob('**/*.ts')).toEqual(['apps/web/a.ts', 'b.ts']);
    expect(await app.glob('.claude/*.json')).toEqual(['.claude/settings.json']);
  });

  test('a path outside the app root is refused before anything is touched', async () => {
    const app = fsCodemodApp(root());
    await expect(app.write('../escape.ts', 'x')).rejects.toMatchObject({
      code: 'X_SCAFFOLD_PATH_ESCAPE',
    });
    await expect(app.read('/etc/passwd')).rejects.toMatchObject({ code: 'X_SCAFFOLD_PATH_ESCAPE' });
  });

  // `..` is not the only way out: a directory under the root that is a symlink to elsewhere (a
  // linked `guards/`) resolved inside lexically, and a write through it landed outside the app.
  test('a symlinked directory leading outside the root is refused, and nothing lands there', async () => {
    const dir = root();
    const outside = root();
    symlinkSync(outside, join(dir, 'guards'), 'dir');
    const app = fsCodemodApp(dir);
    await expect(app.write('guards/a.ts', 'x')).rejects.toMatchObject({
      code: 'X_SCAFFOLD_PATH_ESCAPE',
    });
    await expect(app.write('guards/deeper/a.ts', 'x')).rejects.toMatchObject({
      code: 'X_SCAFFOLD_PATH_ESCAPE',
    });
    expect(existsSync(join(outside, 'a.ts'))).toBe(false);
    expect(existsSync(join(outside, 'deeper'))).toBe(false);
    await Bun.write(join(outside, 'secret.ts'), 'secret\n');
    await expect(app.read('guards/secret.ts')).rejects.toMatchObject({
      code: 'X_SCAFFOLD_PATH_ESCAPE',
    });
    await expect(app.remove('guards/secret.ts')).rejects.toMatchObject({
      code: 'X_SCAFFOLD_PATH_ESCAPE',
    });
    expect(existsSync(join(outside, 'secret.ts'))).toBe(true);
  });

  test('a symlinked file, or one dangling to a path outside, is refused too', async () => {
    const dir = root();
    const outside = root();
    await Bun.write(join(outside, 'real.ts'), 'x\n');
    symlinkSync(join(outside, 'real.ts'), join(dir, 'linked.ts'));
    symlinkSync(join(outside, 'gone.ts'), join(dir, 'dangling.ts'));
    const app = fsCodemodApp(dir);
    await expect(app.read('linked.ts')).rejects.toMatchObject({ code: 'X_SCAFFOLD_PATH_ESCAPE' });
    await expect(app.write('dangling.ts', 'x')).rejects.toMatchObject({
      code: 'X_SCAFFOLD_PATH_ESCAPE',
    });
    expect(existsSync(join(outside, 'gone.ts'))).toBe(false);
  });

  test('a link that stays inside the root, and a root reached through a link, are the app', async () => {
    const dir = root();
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'alias'), 'dir');
    const holder = root();
    symlinkSync(dir, join(holder, 'app'), 'dir');
    const app = fsCodemodApp(join(holder, 'app'));
    await app.write('alias/a.ts', 'x\n');
    expect(await Bun.file(join(dir, 'real/a.ts')).text()).toBe('x\n');
    expect(await app.read('alias/a.ts')).toBe('x\n');
  });
});
