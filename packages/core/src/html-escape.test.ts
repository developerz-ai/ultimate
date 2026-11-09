// The one HTML character table. Four packages each carried their own and they disagreed — five
// characters in http and mail, four in the shot matrix, three (no quotes) in the dev dashboard —
// so an attribute was safe or a hole depending on which package happened to write it.

import { describe, expect, test } from 'bun:test';
import { escapeHtml } from './html-escape';

describe('escapeHtml', () => {
  test('escapes all five characters that can end text or a quoted attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  test('escapes the ampersand FIRST, so an existing reference is escaped once, not decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('&&')).toBe('&amp;&amp;');
  });

  test('leaves every other character alone, astral pairs included', () => {
    expect(escapeHtml('plain text 😀 ü / = `')).toBe('plain text 😀 ü / = `');
    expect(escapeHtml('')).toBe('');
  });

  test('an escaped value contains no character that can close a tag or either quote', () => {
    const escaped = escapeHtml(`"'<>&`.repeat(3));
    expect(escaped).not.toMatch(/[<>"']/);
    expect(escaped.replaceAll(/&(?:amp|lt|gt|quot|#39);/g, '')).toBe('');
  });
});

// The fast path (no special character → the input itself) must answer exactly what the one-pass
// replace answers: every special at the start, middle and end, alone and mixed, and every code
// unit below U+0300 plus a lone surrogate and an astral pair. The reference is the table, spelled
// out here so a change to it is a change to this test too.
describe('escapeHtml · the fast path changes no answer', () => {
  const TABLE: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  const reference = (value: string): string =>
    [...value].map((char) => (Object.hasOwn(TABLE, char) ? TABLE[char] : char)).join('');

  test('every special character, wherever it sits', () => {
    for (const special of Object.keys(TABLE)) {
      for (const value of [
        special,
        `${special}x`,
        `x${special}`,
        `ab${special}cd`,
        special.repeat(3),
      ]) {
        expect(escapeHtml(value)).toBe(reference(value));
      }
    }
  });

  test('every code unit below U+0300, a lone surrogate and an astral pair', () => {
    const units = Array.from({ length: 0x300 }, (_, code) => String.fromCharCode(code));
    for (const value of [...units, '\uD800', 'x\uDFFFy', '😀', units.join('')]) {
      expect(escapeHtml(value)).toBe(reference(value));
    }
  });

  test('a string with nothing to escape comes back as itself', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml('c1@example.com')).toBe('c1@example.com');
  });
});

describe('escapeHtml · one global regex, no state between calls', () => {
  test('a call after an escaping one starts from the beginning', () => {
    // `test` on a global regex moves `lastIndex`; a call that inherited it would skip a prefix.
    for (const [first, second] of [
      ['<a>', '&'],
      ['xxxxx<', '<y'],
      ['plain', 'a"b'],
    ] as const) {
      escapeHtml(first);
      expect(escapeHtml(second)).toBe(
        second.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
      );
    }
  });
});
