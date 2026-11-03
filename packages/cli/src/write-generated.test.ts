// `x new` writes `AGENTS.md` as a relative symlink to `CLAUDE.md` on POSIX — a regular file there is
// a second copy that drifts — and falls back to a copy only where Windows refuses the privilege.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no lstat/readlink, temp-directory or recursive-remove API.
import { lstatSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNewApp } from './cmd-new';
import { writeGenerated } from './write-generated';

const dirs: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-write-generated-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const linkFile = { path: 'AGENTS.md', contents: '# conventions\n', link: 'CLAUDE.md' } as const;
const refused = (code: string) => async (): Promise<void> => {
  throw Object.assign(new TypeError(`symlink refused: ${code}`), { code });
};

describe('unit · writeGenerated', () => {
  test('a plain file is written as bytes', async () => {
    const root = fresh();
    expect(await writeGenerated(root, { path: 'a/b.txt', contents: 'hi' })).toBe('file');
    expect(await Bun.file(join(root, 'a/b.txt')).text()).toBe('hi');
  });

  test('a link entry lands as a relative symlink, replacing what was there', async () => {
    const root = fresh();
    await Bun.write(join(root, 'AGENTS.md'), 'stale');
    expect(await writeGenerated(root, linkFile)).toBe('link');
    expect(lstatSync(join(root, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'AGENTS.md'))).toBe('CLAUDE.md');
  });

  test('Windows refusing the privilege falls back to a copy of the contents', async () => {
    const root = fresh();
    const how = await writeGenerated(root, linkFile, { link: refused('EPERM'), platform: 'win32' });
    expect(how).toBe('copy');
    expect(lstatSync(join(root, 'AGENTS.md')).isFile()).toBe(true);
    expect(await Bun.file(join(root, 'AGENTS.md')).text()).toBe(linkFile.contents);
  });

  test('off Windows a refused link is an error, never a silent copy', async () => {
    const root = fresh();
    const write = writeGenerated(root, linkFile, { link: refused('EPERM'), platform: 'linux' });
    await expect(write).rejects.toThrow('EPERM');
  });

  test('on Windows an error that is not the privilege still surfaces', async () => {
    const root = fresh();
    const write = writeGenerated(root, linkFile, { link: refused('EIO'), platform: 'win32' });
    await expect(write).rejects.toThrow('EIO');
  });
});

describe('unit · x new on disk', () => {
  test.skipIf(process.platform === 'win32')(
    'AGENTS.md is a relative symlink to CLAUDE.md, never a regular file',
    async () => {
      const root = fresh();
      await writeNewApp(root, { name: 'link-demo', example: false });
      const agents = join(root, 'AGENTS.md');
      expect(lstatSync(agents).isSymbolicLink()).toBe(true);
      expect(readlinkSync(agents)).toBe('CLAUDE.md');
      expect(lstatSync(join(root, 'CLAUDE.md')).isFile()).toBe(true);
      expect(await Bun.file(agents).text()).toContain('`AGENTS.md` being a symlink to it');
    },
  );
});
