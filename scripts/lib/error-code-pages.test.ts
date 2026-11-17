// The one reader of the error-code page set: which files are in it, the code rows a page carries,
// the order rows are kept in, and the shape a new owner page opens with.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { isErrorCodesPage } from '@ultimat3/manifest';
import {
  codeRows,
  compareCodes,
  ERROR_CODE_INDEX,
  errorCodePageFiles,
  insertCodeRow,
  isErrorCodePage,
  ownerOfPage,
  ownerPage,
  ownerPageText,
  readErrorCodePages,
} from './error-code-pages';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './run';

// Two cases read the real wiki/, so the file runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/error-code-pages-`);
  made.push(dir);
  await mkdir(`${dir}/wiki`, { recursive: true });
  for (const [path, text] of Object.entries(files)) await Bun.write(`${dir}/${path}`, text);
  return dir;
}

describe('the page set', () => {
  test('the index first, then every owner page in name order; nothing else in wiki/', async () => {
    const root = await tree({
      'wiki/Error-Codes-http.md': '',
      'wiki/Error-Codes.md': '',
      'wiki/Error-Codes-cli.md': '',
      'wiki/Home.md': '',
      'wiki/Error-Codes-Notes.txt': '',
    });
    expect(await errorCodePageFiles(root)).toEqual([
      ERROR_CODE_INDEX,
      'wiki/Error-Codes-cli.md',
      'wiki/Error-Codes-http.md',
    ]);
  });

  test('a tree with no wiki/ has an empty set, never an ENOENT', async () => {
    const root = await mkdtemp(`${tmpdir()}/error-code-pages-bare-`);
    made.push(root);
    expect(await readErrorCodePages(root)).toEqual([]);
  });

  test('read with their text, so a reader cites path:line', async () => {
    const root = await tree({ 'wiki/Error-Codes.md': 'index', 'wiki/Error-Codes-db.md': 'db' });
    expect(await readErrorCodePages(root)).toEqual([
      { path: ERROR_CODE_INDEX, text: 'index' },
      { path: 'wiki/Error-Codes-db.md', text: 'db' },
    ]);
  });

  test('a page name is the index or an owner page, by file name or wiki path', () => {
    expect(isErrorCodePage('Error-Codes.md')).toBe(true);
    expect(isErrorCodePage('wiki/Error-Codes-cli.md')).toBe(true);
    expect(isErrorCodePage('Error-Codes-scripts.md')).toBe(true);
    expect(isErrorCodePage('Home.md')).toBe(false);
    expect(isErrorCodePage('wiki/Error-Codes-.md')).toBe(false);
    expect(isErrorCodePage('docs/Error-Codes.md')).toBe(false);
  });

  // `x docs` (@ultimat3/manifest) skips the same set by page name; the two rules must agree on every
  // page this wiki has, or the CLI tarball and the offline index would disagree about one page.
  test("the set is the one @ultimat3/manifest's isErrorCodesPage skips, page for page", async () => {
    const names = [...new Bun.Glob('*.md').scanSync({ cwd: `${repoRoot()}/wiki` })];
    for (const name of names) {
      expect([name, isErrorCodePage(name)]).toEqual([name, isErrorCodesPage(name.slice(0, -3))]);
    }
  });

  test('an owner page names its owner; the index names none', () => {
    expect(ownerPage('cli')).toBe('wiki/Error-Codes-cli.md');
    expect(ownerOfPage('wiki/Error-Codes-cli.md')).toBe('cli');
    expect(ownerOfPage(ERROR_CODE_INDEX)).toBeUndefined();
  });

  test('this repository carries the index and one page per owner', async () => {
    const files = await errorCodePageFiles(repoRoot());
    expect(files[0]).toBe(ERROR_CODE_INDEX);
    expect(files).toContain('wiki/Error-Codes-core.md');
    expect(files).toContain('wiki/Error-Codes-scripts.md');
  });
});

describe('code rows', () => {
  const page = [
    '| Code | Means | Typical cause | Fix |',
    '|---|---|---|---|',
    '| `X_A` / `X_C` | a or c failed | why | `x a` |',
    '| `X_B` | b failed | why | `x b` |',
    'prose naming `X_D` is not a row',
    '| X_E | plain first cell is an index line, not a row |',
  ].join('\n');

  test('a backticked first cell is a row; its codes, means and line are read off it', () => {
    expect(codeRows(page)).toEqual([
      {
        codes: ['X_A', 'X_C'],
        means: 'a or c failed',
        line: 3,
        text: '| `X_A` / `X_C` | a or c failed | why | `x a` |',
      },
      { codes: ['X_B'], means: 'b failed', line: 4, text: '| `X_B` | b failed | why | `x b` |' },
    ]);
  });

  test('codes sort by code point, so X_A_B precedes X_AB the same on every host', () => {
    expect(['X_AB', 'X_A_B', 'X_A'].sort(compareCodes)).toEqual(['X_A', 'X_AB', 'X_A_B']);
  });

  test('a row is inserted at its sorted place in the first code table', () => {
    const next = insertCodeRow(page, '| `X_AA` | aa | why | `x aa` |');
    expect(next.split('\n')[3]).toBe('| `X_AA` | aa | why | `x aa` |');
    const last = insertCodeRow(page, '| `X_Z` | z | why | `x z` |');
    expect(last.split('\n')[4]).toBe('| `X_Z` | z | why | `x z` |');
  });

  test('a new owner page opens on its title, its link to the index and an empty code table', () => {
    const text = ownerPageText('seo');
    expect(text.split('\n')[0]).toBe('# Error codes: `@ultimat3/seo`');
    expect(text).toContain('[Error codes](Error-Codes)');
    expect(codeRows(insertCodeRow(text, '| `X_S` | s | why | `x s` |'))[0]?.codes).toEqual(['X_S']);
    expect(ownerPageText('scripts').split('\n')[0]).toBe('# Error codes: repository scripts');
  });
});
