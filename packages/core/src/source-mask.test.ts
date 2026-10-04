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

// A template nested inside another template's `${}` closed the OUTER one at its first backtick,
// and every literal after it desynced: `scripts/guards-doc.ts` lost every `code:` below the
// nesting, so the gate never saw them.
describe('a template literal nested inside another template', () => {
  const source = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS template source text.
    "const a = `outer ${items.map((x) => `inner ${x} {`).join('')} tail`;",
    "const b = { code: 'X_AFTER_THE_NESTING' };",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS template source text.
    'const c = `${`${`deep`}`}`;',
    "const d = { code: 'X_AFTER_THE_DEEP_ONE' };",
    "// code: 'X_ONLY_IN_A_COMMENT'",
  ].join('\n');

  test('stripComments keeps every literal after the nesting intact', () => {
    const stripped = stripComments(source);
    expect(stripped).toContain("code: 'X_AFTER_THE_NESTING'");
    expect(stripped).toContain("code: 'X_AFTER_THE_DEEP_ONE'");
    expect(stripped).not.toContain('X_ONLY_IN_A_COMMENT');
  });

  test('maskLiterals blanks the templates whole and nothing after them', () => {
    const masked = maskLiterals(source);
    const lines = masked.split('\n');
    const first = lines[0] ?? '';
    expect(first).toBe(`const a = \`${' '.repeat(first.length - 13)}\`;`);
    expect(lines[1]).toBe("const b = { code: '                   ' };");
    expect(lines[3]).toBe("const d = { code: '                    ' };");
    expect(masked.length).toBe(source.length);
  });
});

describe('a regex literal inside a template placeholder', () => {
  // The shape `admin/src/errors.ts` hid a `code:` behind: `\//` inside `${}` was read as a `//`
  // comment, which swallowed the `}` and the closing backtick, so the rest of the file masked as
  // template text and every scanner reading the mask lost every declaration below it.
  const source =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    "const a = `add ['${p.replace(/^\\//, '')}:read']`;\nconst b = { code: 'X_N', fix: 'f' };\n";

  test('ends the placeholder where it ends, so the code after it is still code', () => {
    const masked = maskLiterals(source);
    expect(masked.length).toBe(source.length);
    expect(masked).toContain('code:');
    expect(masked.split('\n')[0]?.endsWith('`;')).toBe(true);
  });

  test('a division inside a placeholder is still a division', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    const text = "const r = `${a / b} and ${c / 2}`;\nconst d = { code: 'X_D' };\n";
    expect(maskLiterals(text)).toContain('code:');
  });

  test('a comment inside a placeholder is still a comment', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    const text = 'const r = `${a /* } ` */ + b}`;\nconst d = { code: 1 };\n';
    expect(maskLiterals(text)).toContain('code:');
  });
});
