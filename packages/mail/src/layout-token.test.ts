// `token()` is the one function in the package that answers a colour, and its name argument can
// reach it untyped from a template. A prototype member must be a refusal, never a crash.

import { describe, expect, test } from 'bun:test';
import { type MailToken, token } from './layout';

describe('token', () => {
  test('a declared token resolves per scheme', () => {
    expect(token('accentBg')).toBe('#2f6df6');
    expect(token('accentBg', 'dark')).toBe('#4f86ff');
  });

  for (const name of ['constructor', 'toString']) {
    test(`${name} is refused with a code, never read off the prototype`, () => {
      expect(() => token(name as MailToken)).toThrow(/X_INVARIANT/);
    });
  }
});
