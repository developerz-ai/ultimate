// The column name reaches the pattern literally: a metacharacter in it never widens the match.
import { describe, expect, test } from 'bun:test';
import { trigramColumns } from './plan-trigram';

describe('trigramColumns', () => {
  test('finds a plain column compared with ilike', () => {
    expect(trigramColumns('select * from p where "title" ilike $1', ['title', 'body'])).toEqual([
      'title',
    ]);
  });

  test('a `.` in the column name matches only a literal dot', () => {
    expect(trigramColumns('where axb ilike $1', ['a.b'])).toEqual([]);
    expect(trigramColumns('where "a.b" ilike $1', ['a.b'])).toEqual(['a.b']);
  });

  test('a `(` or `\\` in the column name is literal, not a pattern', () => {
    expect(trigramColumns('where "a(b" ilike $1', ['a(b'])).toEqual(['a(b']);
    expect(trigramColumns('where "a\\b" ilike $1', ['a\\b'])).toEqual(['a\\b']);
    expect(trigramColumns('where ab ilike $1', ['a\\b'])).toEqual([]);
  });
});
