import { describe, expect, test } from 'bun:test';
import { isCodeRegistry, maskLiterals, scanCodes, scanFixes, stripComments } from './ts-scan';

const fixes = (source: string): readonly string[] =>
  scanFixes(source, 'a.ts').map((site) => site.fix);

describe('stripComments', () => {
  test('blanks line and block comments but keeps line numbers', () => {
    const out = stripComments('const a = 1; // note\n/* two\nlines */\nconst b = 2;');
    expect(out.split('\n')).toHaveLength(4);
    expect(out).not.toContain('note');
    expect(out).not.toContain('lines');
    expect(out).toContain('const b = 2;');
  });

  test('leaves a comment marker that is inside a string literal alone', () => {
    expect(stripComments("const url = 'https://ultimate.dev/x';")).toContain(
      'https://ultimate.dev/x',
    );
  });
});

describe('maskLiterals', () => {
  test('keeps the delimiters and the length, blanks only the contents', () => {
    const source = "const a = 'hello';";
    const masked = maskLiterals(source);
    expect(masked).toHaveLength(source.length);
    expect(masked).toBe("const a = '     ';");
  });
});

describe('scanFixes', () => {
  test('reads a plain literal', () => {
    expect(fixes("throw new E({ fix: 'x doctor --json' });")).toEqual(['x doctor --json']);
  });

  test('reads both branches of a ternary and a ?? default', () => {
    expect(fixes("({ fix: hit ? 'x help' : 'x verify --json' })")).toEqual([
      'x help',
      'x verify --json',
    ]);
    expect(fixes("({ fix: input.fix ?? 'x help' })")).toEqual(['x help']);
  });

  // The bug this guards: every literal in the expression used to count, so `.join(' ')`'s
  // separator and `TABLE['key']`'s key were reported as empty and vague fix lines.
  test('ignores literals nested inside a call or an index', () => {
    expect(fixes("({ fix: command.join(' ') })")).toEqual([]);
    expect(fixes("({ fix: FIXES['starttls'] ?? '' })")).toEqual(['']);
  });

  test('stops at the property that follows', () => {
    expect(fixes("({ fix: 'x help', docs: 'https://ultimate.dev/errors/X_A' })")).toEqual([
      'x help',
    ]);
  });

  test('ignores a fix: written in a comment or interpolated into a message', () => {
    expect(fixes('// fix:   x db gen "add publish_at"\nconst a = 1;')).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    expect(fixes('const line = `${code}: ${cause} (fix: ${fix})`;')).toEqual([]);
  });

  // `cond ? e.fix : ''` is a ternary on a property named fix, not a fix declaration.
  test('ignores a member access followed by a ternary colon', () => {
    expect(fixes("const fix = typeof e.fix === 'string' ? e.fix : '';")).toEqual([]);
  });

  test('reports the line the literal is on, not the line the key is on', () => {
    const source = "throw new E({\n  code: 'X_A',\n  fix:\n    'x help',\n});";
    expect(scanFixes(source, 'a.ts')[0]).toEqual({ at: 'a.ts', line: 4, fix: 'x help' });
  });

  test('a runtime-computed fix has no literal to read', () => {
    expect(fixes('({ fix: input.fix })')).toEqual([]);
    expect(fixes('interface F { readonly fix: string }')).toEqual([]);
  });
});

describe('scanCodes', () => {
  test('collects throw sites anywhere', () => {
    expect(scanCodes("throw new E({ code: 'X_A', fix: 'x help' });", 'thing.ts')).toEqual([
      { at: 'thing.ts', line: 1, code: 'X_A' },
    ]);
    expect(scanCodes("static readonly code = 'X_B';", 'thing.ts').map((s) => s.code)).toEqual([
      'X_B',
    ]);
  });

  test('collects list and table entries, but only in a code registry', () => {
    const list = "export const CODES = ['X_A', 'X_B'] as const;";
    expect(scanCodes(list, 'errors.ts').map((site) => site.code)).toEqual(['X_A', 'X_B']);
    expect(scanCodes(list, 'thing.ts')).toEqual([]);
    const table = 'const TITLES = {\n  X_C: "third",\n};';
    expect(scanCodes(table, 'packages/x/src/errors.ts').map((site) => site.code)).toEqual(['X_C']);
  });

  // The bug this guards: `Bun.env['X_BUILD_ID']` and an HTTP status map keyed by code are
  // references. Collecting them invented two codes that no package could ever document.
  test('does not invent a code from a reference outside a registry', () => {
    expect(scanCodes("Bun.env['X_BUILD_ID'] ?? 'dev'", 'live.ts')).toEqual([]);
    expect(scanCodes('const STATUS = { X_TIMEOUT: 504 };', 'error-map.ts')).toEqual([]);
  });

  test('a code named only in a comment is not declared', () => {
    expect(scanCodes('// throws X_A when the row is missing\n', 'errors.ts')).toEqual([]);
  });

  test('deduplicates a code declared twice in one file', () => {
    expect(scanCodes("code: 'X_A'; code: 'X_A';", 'thing.ts')).toHaveLength(1);
  });
});

describe('isCodeRegistry', () => {
  test('only a package errors.ts or core error-codes.ts', () => {
    expect(isCodeRegistry('packages/db/src/errors.ts')).toBe(true);
    expect(isCodeRegistry('packages/core/src/error-codes.ts')).toBe(true);
    expect(isCodeRegistry('packages/core/src/image/errors.ts')).toBe(true);
    expect(isCodeRegistry('packages/cli/src/mcp-errors.ts')).toBe(false);
    expect(isCodeRegistry('packages/http/src/error-map.ts')).toBe(false);
  });
});
