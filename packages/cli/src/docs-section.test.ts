// A wiki topic handed back to `x docs`: parsed only when it can name a file inside the wiki, and
// answered with the section whole, or not at all so the caller can search instead.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or path primitive; the fixture wiki is a real directory on disk.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWikiTopic, sectionResult } from './docs-section';

const madeDirs: string[] = [];
afterAll(() => {
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const wikiWith = (files: Readonly<Record<string, string>>) => {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-docs-section-'));
  madeDirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, relative: 'wiki', version: '30.0.0' };
};

describe('unit · parseWikiTopic', () => {
  test('a page and an anchor, with or without the wiki. prefix', () => {
    expect(parseWikiTopic('Upgrading#28x--2900-entry-by-entry')).toEqual({
      page: 'Upgrading',
      anchor: '28x--2900-entry-by-entry',
    });
    expect(parseWikiTopic('wiki.Upgrading#a')).toEqual({ page: 'Upgrading', anchor: 'a' });
  });

  test('never a path, a package guide topic or a question', () => {
    expect(parseWikiTopic('../etc/passwd#x')).toBeUndefined();
    expect(parseWikiTopic('jobs.README#queues')).toBeUndefined();
    expect(parseWikiTopic('how do I upgrade')).toBeUndefined();
  });
});

describe('unit · sectionResult', () => {
  const page =
    '# Upgrading\n\n## 2.x → 3.0.0, entry by entry\n\nOne.\n\n### Entry 1\n\nA.\n\n## 1.x → 2.0.0, entry by entry\n\nTwo.\n';

  test('the whole section, its subsections included, as the one match', async () => {
    const wiki = wikiWith({ 'Upgrading.md': page });
    const result = await sectionResult(
      wiki,
      { page: 'Upgrading', anchor: '2x--300-entry-by-entry' },
      'q',
    );
    expect(result?.ok).toBe(true);
    const data = result?.data as { matches: { text: string; source: string; version: string }[] };
    expect(data.matches[0]?.text).toBe(
      '## 2.x → 3.0.0, entry by entry\n\nOne.\n\n### Entry 1\n\nA.',
    );
    expect(data.matches[0]?.source).toBe('wiki/Upgrading.md');
    expect(data.matches[0]?.version).toBe('30.0.0');
  });

  test('a missing page, a missing anchor and Error-Codes are each no answer', async () => {
    const wiki = wikiWith({ 'Upgrading.md': page, 'Error-Codes.md': '## X_A\n' });
    expect(await sectionResult(wiki, { page: 'Nope', anchor: 'a' }, 'q')).toBeUndefined();
    expect(await sectionResult(wiki, { page: 'Upgrading', anchor: 'nope' }, 'q')).toBeUndefined();
    expect(await sectionResult(wiki, { page: 'Error-Codes', anchor: 'x_a' }, 'q')).toBeUndefined();
  });
});
