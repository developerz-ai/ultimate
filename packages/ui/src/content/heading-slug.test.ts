// GitHub wiki anchors: the slug rules, de-duplication in document order, nested headings counted.

import { expect, test } from 'bun:test';
import { headingIds, headingSlug } from './heading-slug';
import { parseMarkdown } from './markdown-parse';

test('lowercase, punctuation dropped but - and _, spaces to -', () => {
  expect(headingSlug('Error Codes')).toBe('error-codes');
  expect(headingSlug('`x verify` — the gate!')).toBe('x-verify--the-gate');
  expect(headingSlug('snake_case & kebab-case')).toBe('snake_case--kebab-case');
  expect(headingSlug('Über Café 2')).toBe('über-café-2');
});

test('a repeat gets -1, -2 in document order, quotes and lists included', () => {
  const blocks = parseMarkdown('# Setup\n\n## Setup\n\n> ### Setup\n\n- #### Other');
  expect([...headingIds(blocks).values()]).toEqual(['setup', 'setup-1', 'setup-2', 'other']);
});
