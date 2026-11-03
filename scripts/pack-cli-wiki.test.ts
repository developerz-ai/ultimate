// The wiki `x docs` answers from reaches the tarball: the page filter, the copy on a fixture tree,
// and one real `bun pm pack --dry-run` of `packages/cli`, whose `prepack` must put `wiki/Home.md` in
// and whose `postpack` must leave the checkout as it found it.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp, directory listing or recursive remove; these fixtures are synchronous.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { cleanWiki, packWiki, shippedPages } from './pack-cli-wiki';

// Reads the real tree, so it runs on the repo-scan backstop — see `REPO_SCAN_TIMEOUT_MS`.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRoot(pages: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ultimate-pack-wiki-'));
  madeDirs.push(root);
  mkdirSync(join(root, 'wiki'));
  mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
  for (const page of pages) writeFileSync(join(root, 'wiki', page), `# ${page}\n`);
  return root;
}

describe('unit · shippedPages', () => {
  test('every page but Error-Codes and the GitHub chrome, sorted', () => {
    expect(
      shippedPages(['Upgrading.md', 'Error-Codes.md', '_Sidebar.md', 'Home.md', 'notes.txt']),
    ).toEqual(['Home.md', 'Upgrading.md']);
  });
});

describe('unit · packWiki', () => {
  test('copies the shipped pages and cleanWiki removes them again', () => {
    const root = fixtureRoot(['Home.md', 'Error-Codes.md', 'Upgrading.md']);
    expect(packWiki(root)).toEqual({ pages: ['Home.md', 'Upgrading.md'] });
    expect(readdirSync(join(root, 'packages', 'cli', 'wiki')).sort()).toEqual([
      'Home.md',
      'Upgrading.md',
    ]);
    cleanWiki(root);
    expect(existsSync(join(root, 'packages', 'cli', 'wiki'))).toBe(false);
  });

  test('a checkout with no wiki/Home.md refuses, so a publish cannot ship without it', () => {
    const result = packWiki(fixtureRoot(['Upgrading.md']));
    expect(result.pages).toEqual([]);
    expect(result.finding?.code).toBe('X_PACKAGE_SHAPE');
  });
});

describe('unit · the real tarball', () => {
  test('bun pm pack of packages/cli carries wiki/Home.md, never Error-Codes, and cleans up', async () => {
    const cli = join(repoRoot(), 'packages', 'cli');
    const proc = Bun.spawn(['bun', 'pm', 'pack', '--dry-run'], {
      cwd: cli,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' });
    expect(out).toContain('wiki/Home.md');
    expect(out).toContain('wiki/Upgrading.md');
    expect(out).not.toContain('wiki/Error-Codes.md');
    expect(existsSync(join(cli, 'wiki'))).toBe(false);
  }, 60_000);
});
