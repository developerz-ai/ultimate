// `x doctor`'s view of codemods still owed: one warning naming the files and the codemods, and
// nothing at all once they have run — a dry run, so the doctor writes nothing.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { Codemod } from './codemod';
import { fsCodemodApp } from './engine-fs';
import { pendingCodemodFindings } from './pending';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fix: Codemod = {
  id: 'fix-a',
  since: '31.28.0',
  summary: 'a.txt says new',
  async run(app) {
    if ((await app.read('a.txt')) === 'old\n') await app.write('a.txt', 'new\n');
    return { changed: ['a.txt'], skipped: [] };
  },
};

describe('unit · codemods still owed', () => {
  test('an app an older CLI hopped is told, with the files, and nothing is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-codemods-pending-'));
    dirs.push(dir);
    await Bun.write(join(dir, 'a.txt'), 'old\n');
    const [finding, ...rest] = await pendingCodemodFindings(dir, '31.28.0', [fix]);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_UPGRADE_CODEMODS_PENDING');
    expect(finding?.cause).toContain('fix-a (31.28.0)');
    expect(finding?.at).toBe('a.txt');
    expect(finding?.fix).toStartWith('x upgrade codemods --from 0.0.0 --json');
    expect(await Bun.file(join(dir, 'a.txt')).text()).toBe('old\n');
  });

  test('a prerelease CLI owes what its release owes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-codemods-pending-'));
    dirs.push(dir);
    await Bun.write(join(dir, 'a.txt'), 'old\n');
    expect(await pendingCodemodFindings(dir, '31.28.0-next.1', [fix])).toHaveLength(1);
  });

  test('applied, or past this CLI’s release, is nothing owed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-codemods-pending-'));
    dirs.push(dir);
    await Bun.write(join(dir, 'a.txt'), 'old\n');
    expect(await pendingCodemodFindings(dir, '31.27.0', [fix])).toEqual([]);
    await fix.run(fsCodemodApp(dir));
    expect(await pendingCodemodFindings(dir, '31.28.0', [fix])).toEqual([]);
  });
});
