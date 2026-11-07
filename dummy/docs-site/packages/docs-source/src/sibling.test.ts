import { expect, test } from 'bun:test';
import { readCorpus } from './corpus';
import { FIXTURE_OPTIONS, WIKI } from './corpus-fixture';
import { codeMarkdown, pieceMarkdown, siblingPath } from './sibling';

const corpus = readCorpus(WIKI, FIXTURE_OPTIONS);

test('a page sibling is its title and body; its path is the URL plus .md', () => {
  const guide = corpus.pages.find((piece) => piece.url === '/getting-started');
  if (guide === undefined) return expect.unreachable('no guide page');
  expect(pieceMarkdown(guide).startsWith('# Getting started\n\nFour commands.')).toBe(true);
  expect(siblingPath('/getting-started')).toBe('getting-started.md');
  expect(siblingPath('/errors/X_A')).toBe('errors/X_A.md');
});

test('a code sibling carries every row, each cell under the wiki column header', () => {
  const a = corpus.codes.find((piece) => piece.code === 'X_A');
  if (a === undefined) return expect.unreachable('no X_A page');
  const text = codeMarkdown(a);
  expect(text.startsWith('# X_A\n\n## Means\n\ntwo at once')).toBe(true);
  expect(text).toContain('[Core](/error-codes#core)\n\n---\n\n## Means\n\nagain');
});
