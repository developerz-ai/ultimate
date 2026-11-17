// The wiki scanner's contract: a topic is the page's public fragment, a fence is never a heading,
// a section read is the whole section and nothing past it, and `every `Error-Codes` page stays out.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or path primitive; the fixture is a real directory on disk.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  githubSlug,
  isErrorCodesPage,
  scanWikiDocs,
  wikiEntries,
  wikiHeadings,
  wikiSection,
} from './docs-wiki';

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
    writeFileSync(join(dir, 'Error-Codes-db.md'), '# Error codes: db\n\n## X_DB_A\n');
    // Only the prefix `Error-Codes-` is the page set: a page that merely starts with the word is read.
    writeFileSync(join(dir, 'Error-Codesmith.md'), '# Smith\n');
    writeFileSync(join(dir, '_Sidebar.md'), '## Nav\n');
    writeFileSync(join(dir, 'notes.txt'), '## not markdown\n');
    const topics = (await scanWikiDocs(dir, ORIGIN)).map((entry) => entry.topic);
    expect(topics).toContain('wiki.Upgrading#28x--2900-entry-by-entry');
    expect(topics.filter((topic) => !topic.startsWith('wiki.Upgrading'))).toEqual([
      'wiki.Error-Codesmith',
    ]);
  });

  test('isErrorCodesPage names the index and every owner page, nothing else', () => {
    expect(['Error-Codes', 'Error-Codes-db', 'Error-Codes-scripts'].map(isErrorCodesPage)).toEqual([
      true,
      true,
      true,
    ]);
    expect(['Error-Codesmith', 'Errors', 'Home'].map(isErrorCodesPage)).toEqual([
      false,
      false,
      false,
    ]);
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

// CodeQL js/polynomial-redos (sweep 8b-3): the heading, link and tag patterns each retried a run
// from every character of it — over 15 s on a CRLF heading of 10k spaces, over 15 s on 100k `![`,
// 4.3 s on 100k `<`. The readers are forward walks now; the old patterns are the oracle.
describe('headings and slugs are read in linear time, with the old answers', () => {
  const OLD_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  const oldSlug = (heading: string): string =>
    heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replaceAll('`', '')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replaceAll(' ', '-');
  const every = (alphabet: readonly string[], max: number, check: (text: string) => void) => {
    let level = [''];
    for (let length = 0; length <= max; length += 1) {
      for (const text of level) check(text);
      level = level.flatMap((head) => alphabet.map((one) => head + one));
    }
  };

  test('every slug of up to 5 link, tag and word characters', () => {
    every(['!', '[', ']', '(', ')', '<', '>', 'a', ' '], 5, (text) => {
      expect([text, githubSlug(text)]).toEqual([text, oldSlug(text)]);
    });
  });

  // Longer than the exhaustive run reaches: a URL is only observable once a link closes, and a
  // failed `[…]` before a real link takes eight characters to spell.
  test('a failed bracket, a nested one, an image and a tag around a link', () => {
    const cases = [
      '[]a[](b)',
      '[a [b] c](d) e',
      'x ![alt](img.png) y [t](u)',
      '[a](b <c>) <d [e](f)> g',
      'see [the `api`](./api) and <kbd>x</kbd>',
      '[a](b(c)d)',
      'a <> b <c',
    ];
    for (const text of cases) expect([text, githubSlug(text)]).toEqual([text, oldSlug(text)]);
  });

  test('every heading line of up to 7 marks, blanks, words and carriage returns', () => {
    every([' ', '\t', '#', 'a', '\r'], 7, (line) => {
      const match = OLD_HEADING.exec(line);
      const heading = match?.[2] ?? '';
      const expected =
        match === null
          ? []
          : [{ level: (match[1] ?? '').length, heading, anchor: oldSlug(heading), line: 0 }];
      expect([line, wikiHeadings(line)]).toEqual([line, expected]);
    });
  });

  test('hostile headings of 100k characters are read in well under a second', () => {
    const started = performance.now();
    expect(wikiHeadings(`# ${' '.repeat(100_000)}\r`)).toEqual([]);
    expect(githubSlug('!['.repeat(100_000))).toBe('');
    expect(githubSlug('[](x'.repeat(100_000))).toBe('x'.repeat(100_000));
    expect(githubSlug('<'.repeat(100_000))).toBe('');
    expect(performance.now() - started).toBeLessThan(250);
  });
});
