// What `jsonb` refuses of text `JSON.stringify` accepts, asked of the text itself so memory and
// Postgres answer alike: the refusal has to land before a store does, or only production sees it.

import { describe, expect, test } from 'bun:test';
import { jsonbRefusal } from './json-storable';

const of = (value: unknown): string | undefined => jsonbRefusal(JSON.stringify(value));

describe('jsonbRefusal', () => {
  test.each([
    ['a NUL in a value', 'vendor\u0000note'],
    ['a NUL in a nested value', { a: [{ b: '\u0000' }] }],
    ['a NUL in a key', { 'a\u0000': 1 }],
    ['a lone high surrogate', 'x\ud83d'],
    ['a lone low surrogate', '\ude00x'],
    ['a NUL after an escaped backslash', '\\\u0000'],
  ])('%s is refused', (_label, value) => {
    expect(of(value)).toBeString();
  });

  test.each([
    ['plain text', 'vendor note'],
    ['a surrogate pair', 'ok 😀'],
    ['the six characters of an escape, as text', '\\u0000'],
    ['an escaped surrogate, as text', '\\ud83d'],
    ['two backslashes then the text', '\\\\u0000'],
    ['other control characters', '\u0001\n\t'],
    ['a number, a boolean and a null', [1, true, null]],
  ])('%s passes', (_label, value) => {
    expect(of(value)).toBeUndefined();
  });

  test('the reason names the class of thing and never the text', () => {
    expect(of('secret\u0000')).not.toContain('secret');
    expect(of('secret\ud83d')).not.toContain('secret');
  });
});
