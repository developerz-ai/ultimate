// What `x docs` reads, on a fixture install: both scope directories, each package once, and the
// wiki wherever this CLI's layout puts it — or a stated absence, never a silent empty one.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or path primitive; the fixture install is a real tree on disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDocs, wikiDirFor, wikiSource } from './docs-sources';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'ultimate-docs-sources-'));
  madeDirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const pkg = (name: string, readme: string): Record<string, string> => ({
  [`${name}/package.json`]: JSON.stringify({ name: `@ultimat3/${name}`, version: '30.0.0' }),
  [`${name}/README.md`]: readme,
});

describe('unit · wikiDirFor', () => {
  test("an install's wiki is inside the CLI package", () => {
    const root = tree({ 'cli/wiki/Home.md': '# Home\n' });
    expect(wikiDirFor(join(root, 'cli'))).toBe(join(root, 'cli', 'wiki'));
  });

  test("a checkout's wiki is the repository's own, two directories up", () => {
    const root = tree({ 'packages/cli/package.json': '{}', 'wiki/Home.md': '# Home\n' });
    expect(wikiDirFor(join(root, 'packages', 'cli'))).toBe(
      join(root, 'packages', 'cli', '..', '..', 'wiki'),
    );
  });

  // Installed, two up from `node_modules/@ultimat3/cli` is `node_modules/`: an npm package named
  // `wiki` would be read as the framework's manual. The fallback is the checkout's, or nothing.
  test('an installed CLI never reads node_modules/wiki as its wiki', () => {
    const root = tree({
      'node_modules/@ultimat3/cli/package.json': '{}',
      'node_modules/wiki/Home.md': '# Not ours\n',
    });
    expect(wikiDirFor(join(root, 'node_modules', '@ultimat3', 'cli'))).toBeUndefined();
  });

  test('no Home.md anywhere is no wiki', () => {
    expect(wikiDirFor(join(tree({ 'cli/package.json': '{}' }), 'cli'))).toBeUndefined();
  });
});

describe('unit · wikiSource', () => {
  test('carries the CLI version and the path a hit is written against', async () => {
    const root = tree({
      'cli/package.json': JSON.stringify({ name: '@ultimat3/cli', version: '30.1.0' }),
      'cli/wiki/Home.md': '# Home\n',
    });
    expect(await wikiSource(join(root, 'cli'))).toEqual({
      dir: join(root, 'cli', 'wiki'),
      relative: 'wiki',
      version: '30.1.0',
    });
  });
});

describe('unit · loadDocs', () => {
  // The measured miss: an app's own `node_modules/@ultimat3` holds its direct dependencies only,
  // and the CLI's store entry holds the rest. Reading one of them answered for one package.
  test("reads the app's scope and the CLI's, each package once, the app's copy first", async () => {
    const root = tree({
      ...Object.fromEntries(
        Object.entries(pkg('mail', '## From the app\n')).map(([path, text]) => [
          `app/${path}`,
          text,
        ]),
      ),
      ...Object.fromEntries(
        Object.entries({
          ...pkg('mail', '## From the store\n'),
          ...pkg('storage', '## Upload\n'),
          'cli/package.json': JSON.stringify({ name: '@ultimat3/cli', version: '30.0.0' }),
          'cli/wiki/Home.md': '# Home\n\n## Start here\n',
        }).map(([path, text]) => [`store/${path}`, text]),
      ),
    });
    const { entries, wiki } = await loadDocs(join(root, 'app'), join(root, 'store', 'cli'));
    const topics = entries.map((entry) => entry.topic);
    expect(topics).toContain('mail.README#from-the-app');
    expect(topics).not.toContain('mail.README#from-the-store');
    expect(topics).toContain('storage.README#upload');
    expect(topics).toContain('wiki.Home#start-here');
    expect(wiki?.version).toBe('30.0.0');
    expect(entries.find((entry) => entry.topic === 'wiki.Home')?.source).toBe('wiki/Home.md');
  });

  test('an install with no wiki answers from the packages and says the wiki is missing', async () => {
    const root = tree({ ...pkg('mail', '## Send\n'), 'cli/package.json': '{}' });
    const { entries, wiki } = await loadDocs(root, join(root, 'cli'));
    expect(entries.map((entry) => entry.topic)).toContain('mail.README#send');
    expect(wiki).toBeUndefined();
  });
});
