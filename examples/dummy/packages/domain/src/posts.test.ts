// A slug is a URL forever, and `createPost` derives one from any title or normalises a caller's:
// a slug with spaces, or a title with no ASCII letter, must still land a valid slug — it answered
// an undeclared 422 (`X_INVARIANT_VIOLATED`) until the contract's generated input found it.

import { expect, test } from 'bun:test';
import { isValidSlug, slugify } from './posts';

test.each([
  ['Hello, World!', 'hello-world'],
  ['  My Post  ', 'my-post'],
  ['Crème brûlée', 'creme-brulee'],
  ['日本語', 'u65e5-u672c-u8a9e'],
  ['café 東京', 'cafe-u6771-u4eac'],
  ['!!!', 'post'],
  ['', 'post'],
])('%p slugs to %p, a valid slug', (title, slug) => {
  expect(slugify(title)).toBe(slug);
  expect(isValidSlug(slugify(title))).toBe(true);
});

test('two titles in another script keep two slugs', () => {
  expect(slugify('東京')).not.toBe(slugify('京都'));
});

test('a long title is cut to the bound, never ending on a hyphen', () => {
  const slug = slugify('ab '.repeat(80));
  expect(isValidSlug(slug)).toBe(true);
});
