// Failure first: the case that shipped is a `t('…')` inside a comment being read as a call, so the
// mask has to blank a comment while keeping every string literal — and every newline — exactly
// where it was, because a scanner maps its match index back to a line number.

import { describe, expect, test } from 'bun:test';
import { endOfLiteral, maskLiterals, QUOTES, stripComments } from './source-mask';

describe('stripComments', () => {
  test('blanks line and block comments, keeps newlines and every string literal', () => {
    const source = "const a = t('kept'); // t('phantom')\n/* t('ghost')\n */ const b = 'x';";
    const out = stripComments(source);
    expect(out.length).toBe(source.length);
    expect(out.split('\n').length).toBe(source.split('\n').length);
    expect(out).toContain("t('kept')");
    expect(out).not.toContain('phantom');
    expect(out).not.toContain('ghost');
    expect(out).toContain("'x'");
  });

  test('a // inside a string is not a comment', () => {
    const source = "const url = t('http://example.test'); // trailing";
    expect(stripComments(source)).toBe("const url = t('http://example.test');            ");
  });

  test('a regex body holding a quote does not open a literal', () => {
    const source = "const re = /['\"]/; const s = 'after'; // note";
    const out = stripComments(source);
    expect(out).toContain("'after'");
    expect(out).not.toContain('note');
  });
});

describe('maskLiterals', () => {
  test('blanks string contents and keeps the delimiters', () => {
    expect(maskLiterals("t('key')")).toBe("t('   ')");
  });
});

describe('endOfLiteral', () => {
  test('an apostrophe that does not close on its line is text, not a literal', () => {
    const text = "<p>Don't panic</p>\nconst fix = 'x';";
    expect(endOfLiteral(text, text.indexOf("'"))).toBe(text.indexOf("'") + 1);
    expect(QUOTES.has("'")).toBe(true);
  });
});
