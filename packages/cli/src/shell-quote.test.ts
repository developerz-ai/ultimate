// The one quoter, from both ends: a value that needs nothing is left readable, and a value that
// would change the meaning of the line is closed off.

import { describe, expect, test } from 'bun:test';
import { quoteArg } from './shell-quote';

describe('unit · quoteArg', () => {
  test('an ordinary path is left alone, so the common line stays readable', () => {
    expect(quoteArg('packages/cli/src/cmd-test.test.ts')).toBe('packages/cli/src/cmd-test.test.ts');
    expect(quoteArg('')).toBe("''");
    expect(quoteArg('a b')).toBe("'a b'");
  });

  test('a metacharacter cannot start a second command', () => {
    expect(quoteArg('a; rm -rf b')).toBe("'a; rm -rf b'");
    expect(quoteArg('$(id)')).toBe("'$(id)'");
  });

  // `'it'\''s slow'` — close, an escaped quote, reopen. Anything else truncates the argument.
  test('a single quote is escaped the one way a single-quoted string allows', () => {
    expect(quoteArg("it's slow")).toBe("'it'\\''s slow'");
  });
});
