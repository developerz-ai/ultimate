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
