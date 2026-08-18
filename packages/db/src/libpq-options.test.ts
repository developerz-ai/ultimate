// Single responsibility: the merge rule for libpq `options` — what survives from the operator's
// connection string and what the role's profile is allowed to overrule.

import { describe, expect, test } from 'bun:test';
import { mergeLibpqOptions, splitLibpqOptions } from './libpq-options';

describe('splitLibpqOptions', () => {
  test('splits on whitespace and keeps a backslash escape intact', () => {
    expect(splitLibpqOptions('-c search_path=app -c timezone=UTC')).toEqual([
      '-c',
      'search_path=app',
      '-c',
      'timezone=UTC',
    ]);
    // A backslash escapes the separator, so this is ONE argument and re-joining must not split it.
    expect(splitLibpqOptions(String.raw`-c search_path=two\ words`)).toEqual([
      '-c',
      String.raw`search_path=two\ words`,
    ]);
    expect(splitLibpqOptions('   ')).toEqual([]);
  });
});

describe('mergeLibpqOptions', () => {
  test('appends to nothing', () => {
    expect(mergeLibpqOptions(null, { statement_timeout: '10000' })).toBe(
      '-c statement_timeout=10000',
    );
  });

  test("keeps every setting of the operator's the framework does not name", () => {
    expect(
      mergeLibpqOptions('-c search_path=app -c timezone=UTC', { statement_timeout: '0' }),
    ).toBe('-c search_path=app -c timezone=UTC -c statement_timeout=0');
  });

  test('an escaped separator survives the round trip', () => {
    expect(
      mergeLibpqOptions(String.raw`-c search_path=two\ words`, { statement_timeout: '10000' }),
    ).toBe(String.raw`-c search_path=two\ words -c statement_timeout=10000`);
  });

  /**
   * The framework wins on the names it sets, in all three spellings a backend accepts — and by
   * removal, not by position, so the bound does not depend on argument order nobody measured.
   */
  for (const spelling of [
    '-c statement_timeout=1',
    '-cstatement_timeout=1',
    '--statement_timeout=1',
    '--statement-timeout=1',
  ]) {
    test(`the role's value replaces the operator's ${spelling}`, () => {
      expect(mergeLibpqOptions(`${spelling} -c search_path=app`, { statement_timeout: '5' })).toBe(
        '-c search_path=app -c statement_timeout=5',
      );
    });
  }

  test('a setting the framework does not name is never touched by a similar one', () => {
    // The anchor is the `=`, not a prefix, so a longer name that starts the same way is not ours.
    expect(
      mergeLibpqOptions('-c lock_timeout=3000 -c statement_timeout_extra=1', {
        statement_timeout: '5',
      }),
    ).toBe('-c lock_timeout=3000 -c statement_timeout_extra=1 -c statement_timeout=5');
  });
});
