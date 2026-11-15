// The real-filesystem `CodemodApp`: app-root relative posix paths in and out, directories made on
// write, a removal of nothing is no error, no path outside the root, no `node_modules` in a glob.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { fsCodemodApp } from './engine-fs';

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
});
