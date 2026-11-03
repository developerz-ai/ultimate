// The wiki scanner's contract: a topic is the page's public fragment, a fence is never a heading,
// a section read is the whole section and nothing past it, and `Error-Codes` stays out.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or path primitive; the fixture is a real directory on disk.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubSlug, scanWikiDocs, wikiEntries, wikiHeadings, wikiSection } from './docs-wiki';

const ORIGIN = { package: '@ultimat3/cli', version: '30.0.0' } as const;

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const UPGRADING = [
  '# Upgrading',
  '',
  'One major per run.',
  '',
  '```sh',
  '# 417 As of 2026-10-28 — a comment, not a heading',
  '```',
  '',
  '## 28.x → 29.0.0, entry by entry',
  '',
  'Bun 1.4.4 as the floor.',
  '',
  '### Entry by entry',
  '',
  'The first entry.',
  '',
  '## 27.x → 28.0.0, entry by entry',
  '',
  '### Entry by entry',
  '',
  'The older entry.',
].join('\n');

describe('unit · githubSlug', () => {
  test("the arrow leaves two spaces, so two hyphens, as GitHub's own anchor has them", () => {
    expect(githubSlug('28.x → 29.0.0, entry by entry')).toBe('28x--2900-entry-by-entry');
  });

  test('code spans and links render as their text', () => {
    expect(githubSlug('`x upgrade`: one [major](#x) per run')).toBe('x-upgrade-one-major-per-run');
  });
});

describe('unit · wikiHeadings', () => {
  test('a `#` line inside a fence is code, never a heading', () => {
    expect(wikiHeadings(UPGRADING).map((heading) => heading.heading)).toEqual([
      'Upgrading',
      '28.x → 29.0.0, entry by entry',
      'Entry by entry',
      '27.x → 28.0.0, entry by entry',
      'Entry by entry',
    ]);
  });

  test('a repeated heading is numbered as GitHub numbers it, so its link still lands', () => {
    const anchors = wikiHeadings(UPGRADING).map((heading) => heading.anchor);
    expect(anchors).toContain('entry-by-entry');
    expect(anchors).toContain('entry-by-entry-1');
  });
});

describe('unit · wikiEntries', () => {
  test('one entry for the page and one per section, topics under wiki.<Page>', () => {
    const entries = wikiEntries('Upgrading', UPGRADING, ORIGIN);
    expect(entries.map((entry) => entry.topic)).toEqual([
      'wiki.Upgrading',
      'wiki.Upgrading#28x--2900-entry-by-entry',
      'wiki.Upgrading#entry-by-entry',
      'wiki.Upgrading#27x--2800-entry-by-entry',
      'wiki.Upgrading#entry-by-entry-1',
    ]);
    expect(entries[0]).toMatchObject({
      title: 'Upgrading',
      kind: 'guide',
      package: '@ultimat3/cli',
      version: '30.0.0',
      source: 'wiki/Upgrading.md',
    });
    expect(entries[0]?.text).toContain('One major per run.');
    expect(entries[1]?.text).toBe('Bun 1.4.4 as the floor.');
  });
});

describe('unit · wikiSection', () => {
  test('a section runs through its subsections and stops at its next sibling', () => {
    const section = wikiSection(UPGRADING, '28x--2900-entry-by-entry');
    expect(section).toStartWith('## 28.x → 29.0.0, entry by entry');
    expect(section).toContain('The first entry.');
    expect(section).not.toContain('27.x');
  });

  test('a subsection is only itself', () => {
    expect(wikiSection(UPGRADING, 'entry-by-entry-1')).toBe(
      '### Entry by entry\n\nThe older entry.',
    );
  });

  test('an anchor the page does not carry is undefined, not the whole page', () => {
    expect(wikiSection(UPGRADING, 'nope')).toBeUndefined();
  });
});

describe('unit · scanWikiDocs', () => {
  test('Error-Codes and the GitHub chrome stay out; every other page is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultimate-wiki-'));
    madeDirs.push(dir);
    writeFileSync(join(dir, 'Upgrading.md'), UPGRADING);
    writeFileSync(join(dir, 'Error-Codes.md'), '# Error codes\n\n## X_A\n');
    writeFileSync(join(dir, '_Sidebar.md'), '## Nav\n');
    writeFileSync(join(dir, 'notes.txt'), '## not markdown\n');
    const topics = (await scanWikiDocs(dir, ORIGIN)).map((entry) => entry.topic);
    expect(topics).toContain('wiki.Upgrading#28x--2900-entry-by-entry');
    expect(topics.filter((topic) => !topic.startsWith('wiki.Upgrading'))).toEqual([]);
  });

  // `bun update` rewrites the tarball's pages while `x docs` reads them: a page that is listed
  // and then cannot be read costs that page, never every answer. An unreadable file stands in for
  // one that vanished between `exists()` and `text()`, which a test cannot time.
  test('a page that cannot be read costs that page, not the scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultimate-wiki-'));
    madeDirs.push(dir);
    writeFileSync(join(dir, 'Home.md'), '# Home\n\n## Start\n');
    writeFileSync(join(dir, 'Gone.md'), '# Gone\n');
    chmodSync(join(dir, 'Gone.md'), 0o000);
    const topics = (await scanWikiDocs(dir, ORIGIN)).map((entry) => entry.topic);
    expect(topics).toEqual(['wiki.Home', 'wiki.Home#start']);
  });

  test('a directory that is not there is no pages, not a throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ultimate-wiki-'));
    madeDirs.push(root);
    expect(await scanWikiDocs(join(root, 'absent'), ORIGIN)).toEqual([]);
  });
});
