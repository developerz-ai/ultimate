import { describe, expect, test } from 'bun:test';
import {
  isCodeRegistry,
  maskLiterals,
  scanBorrowedCodes,
  scanCodes,
  scanFixes,
  stripComments,
} from './ts-scan';

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

  test('blanks a regex body, keeping its slashes and the length', () => {
    const source = 'const re = /[a-z]+/g;';
    expect(maskLiterals(source)).toBe('const re = /      /g;');
  });

  test('a division is not a regex, so the expression survives masking', () => {
    expect(maskLiterals('const ratio = width / height;')).toBe('const ratio = width / height;');
    expect(maskLiterals('const half = (a + b) / 2;')).toBe('const half = (a + b) / 2;');
  });

  test('a lone slash that never closes is division, not a literal eating the file', () => {
    const source = "const per = total / count;\nconst a = 'x';";
    expect(maskLiterals(source)).toBe("const per = total / count;\nconst a = ' ';");
  });

  test('a JSX close tag and a self-closing tag are not regex literals', () => {
    const source = '<p>{a}</p><b name="x" />;';
    expect(maskLiterals(source)).toBe('<p>{a}</p><b name=" " />;');
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

  // The bug this guards: the quotes inside a regex like this file's own `CODE_LITERAL` read as
  // string delimiters, so the masking desynced and blanked the `fix:` declared after it. The file
  // then reported no fixes at all and the gate passed over error text nobody had checked.
  test('a regex holding quote characters does not hide the declaration after it', () => {
    const source = `const CODE_LITERAL = /(['"\`])(X_[A-Z0-9_]+)\\1/g;
throw new E({ fix: 'x doctor --json' });`;
    expect(fixes(source)).toEqual(['x doctor --json']);
  });

  test('an escape and a character class do not close the regex early', () => {
    expect(fixes("const re = /[/']|a\\/b/;\nthrow new E({ fix: 'x help' });")).toEqual(['x help']);
  });

  test('a division is read as one, so the declaration after it survives', () => {
    expect(fixes("const per = total / count;\nthrow new E({ fix: 'x help' });")).toEqual([
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

describe('scanBorrowedCodes', () => {
  test('reads the codes a registry says are somebody else’s', () => {
    const source = "export const CLI_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const;\n";
    expect([...scanBorrowedCodes(source)]).toEqual(['X_NOT_IMPLEMENTED']);
  });

  test('reads every entry, and every list in one file', () => {
    const source = [
      "export const AUTH_BORROWED_ERROR_CODES = ['X_FORBIDDEN', 'X_NOT_IMPLEMENTED'] as const;",
      "const MORE_BORROWED_ERROR_CODES: readonly string[] = ['X_DB_DRIFT'];",
    ].join('\n');
    expect([...scanBorrowedCodes(source)].sort()).toEqual([
      'X_DB_DRIFT',
      'X_FORBIDDEN',
      'X_NOT_IMPLEMENTED',
    ]);
  });

  // Borrowing is a claim about ownership, so only the declaration makes it — otherwise the prose
  // above every one of these lists would disown the codes the file actually owns.
  test('a code the file owns, or one merely named in prose, is not borrowed', () => {
    const source = [
      '// X_OWNED is ours; BORROWED_ERROR_CODES below names the rest.',
      "export const DB_OWNED_ERROR_CODES = ['X_OWNED'] as const;",
      "export const DB_BORROWED_ERROR_CODES = ['X_LENT'] as const;",
      'export const DB_ERROR_CODES = [...DB_OWNED_ERROR_CODES, ...DB_BORROWED_ERROR_CODES];',
    ].join('\n');
    expect([...scanBorrowedCodes(source)]).toEqual(['X_LENT']);
  });

  test('a file that borrows nothing borrows nothing', () => {
    expect(scanBorrowedCodes("export const CODES = ['X_A'] as const;\n").size).toBe(0);
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
