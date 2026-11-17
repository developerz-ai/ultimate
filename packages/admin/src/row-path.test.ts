// A row id is one path segment: every id round-trips through the admin router to itself.
import { describe, expect, test } from 'bun:test';
import { rowPath } from './row-path';

describe('rowPath', () => {
  test('a plain id is unchanged', () => {
    expect(rowPath('/admin/skus', 'acme')).toBe('/admin/skus/acme');
  });

  test('a separator, fragment, query or percent in a text key stays inside its segment', () => {
    expect(rowPath('/admin/skus', 'acme/edit')).toBe('/admin/skus/acme%2Fedit');
    expect(rowPath('/admin/skus', 'a#1')).toBe('/admin/skus/a%231');
    expect(rowPath('/admin/skus', 'a?b')).toBe('/admin/skus/a%3Fb');
    expect(rowPath('/admin/skus', '%41')).toBe('/admin/skus/%2541');
  });
});
