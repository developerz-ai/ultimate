import { describe, expect, test } from 'bun:test';
import {
  isCodeRegistry,
  maskLiterals,
  scanBorrowedCodes,
  scanCodes,
  stripComments,
} from './ts-scan';

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

  // The bug this guards: an apostrophe in JSX text read as a string opener, so masking ran to the
  // next `'` in the FILE — in practice the next `fix:` literal — and blanked every declaration in
  // between. A `'`/`"` that does not close on its own line is text: a JS string may not span one.
  test('an apostrophe in JSX text is text, not a literal opener', () => {
    const source = "<p>Don't panic</p>;\nconst a = 'x';";
    expect(maskLiterals(source)).toBe("<p>Don't panic</p>;\nconst a = ' ';");
  });

  test('a template literal still spans lines', () => {
    const source = 'const a = `one\ntwo`;\nconst b = 1;';
    expect(maskLiterals(source)).toBe('const a = `   \n   `;\nconst b = 1;');
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

  // Registry-ness is read off the file's own table declaration, so the second argument is only
  // ever the label a finding is reported at — renaming a file cannot change what it declares.
  test('collects list and table entries, but only in a code registry', () => {
    const list = "export const X_ERROR_CODES = ['X_A', 'X_B'] as const;";
    expect(scanCodes(list, 'errors.ts').map((site) => site.code)).toEqual(['X_A', 'X_B']);
    expect(scanCodes("export const CODES = ['X_A', 'X_B'] as const;", 'errors.ts')).toEqual([]);
    const table = 'export const X_ERROR_TITLES = {\n  X_C: "third",\n};';
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
  test('the file that declares the table, in either shape', () => {
    expect(isCodeRegistry("export const DB_ERROR_CODES = ['X_DB_DRIFT'] as const;")).toBe(true);
    expect(isCodeRegistry('export const CORE_ERROR_TITLES: Titles = {')).toBe(true);
    expect(isCodeRegistry("export const HTTP_OWNED_ERROR_CODES = ['X_ROUTE_CONFLICT'];")).toBe(
      true,
    );
  });

  // The regression the filename test could not see: a package that splits its registry in two
  // leaves behind a file still *named* `errors.ts` that declares no codes at all. Calling it a
  // registry hands it every code it throws, and `X_NOT_IMPLEMENTED` moves off `core`.
  test('a classes-only errors.ts is not a registry', () => {
    const source = [
      "import { docsFor } from './error-codes';",
      'export class NotImplementedError extends UltimateError {',
      "  constructor() { super({ code: 'X_NOT_IMPLEMENTED' }); }",
      '}',
    ].join('\n');
    expect(isCodeRegistry(source)).toBe(false);
  });

  test('a file that merely maps or explains codes is not a registry', () => {
    expect(
      isCodeRegistry("const CLI_FIXES: Record<CliErrorCode, string> = { X_A: 'x help' };"),
    ).toBe(false);
    expect(isCodeRegistry("import { HTTP_ERROR_CODES } from './errors';")).toBe(false);
  });
});
