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

  // Same masking desync, reached from JSX rather than from a regex: the file's `fix:` lines
  // vanished wholesale, `x verify`'s `errors` step checked none of them, and `scanCodes` still
  // found the code — so `X_ERROR_CODE_UNDOCUMENTED` passed and hid the hole.
  test('an apostrophe in JSX text does not hide the declaration below it', () => {
    const source =
      'export function Panel() {\n' +
      "  return <p>Don't panic</p>;\n" +
      '}\n' +
      "throw new E({ code: 'X_A', fix: 'x doctor --json' });";
    expect(scanFixes(source, 'a.tsx')).toEqual([{ at: 'a.tsx', line: 4, fix: 'x doctor --json' }]);
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

/**
 * The blind spot that let two stale fix lines ship. `@ultimat3/mcp`'s `readonly-sql.ts` passes its
 * fixes POSITIONALLY into local `rejected(cause, fix)` / `notBranch(cause, fix)` helpers, so there
 * is no `fix:` key anywhere in the file and the scanner returned `[]` for all of it — the citation
 * resolver was never handed a single string to judge.
 */
describe('scanFixes · a fix passed positionally into a local error builder', () => {
  const BUILDER =
    'function rejected(cause: string, fix: string) {\n' +
    "  return new McpError({ code: 'X_A', cause, fix });\n" +
    '}\n';

  test('reads the argument in the fix parameter position', () => {
    expect(fixes(`${BUILDER}rejected('not one statement', 'x db branch ls --json');`)).toEqual([
      'x db branch ls --json',
    ]);
  });

  test('the position is the declared one, not "the last argument"', () => {
    const source =
      'const fail = (field: string, fix: string, meta: object) => {\n' +
      "  throw new E({ code: 'X_B', cause: field, fix });\n" +
      '};\n' +
      "fail('amount', 'x g migration money', { a: 1 });";
    expect(fixes(source)).toEqual(['x g migration money']);
  });

  test('a helper that CONSUMES a fix is not a helper that declares one', () => {
    // `citedCommandProblem(fix: string, catalog)` takes a fix in order to judge it. Reading its
    // call sites as declarations would report findings about strings that are already findings —
    // so a helper only counts when its body builds an error.
    const source =
      'function citedCommandProblem(fix: string, catalog: Catalog) {\n' +
      '  return catalog.resolve(fix);\n' +
      '}\n' +
      "citedCommandProblem('x db branch lst', catalog);";
    expect(fixes(source)).toEqual([]);
  });

  test('a rest or destructured parameter list has no reliable position, so it is skipped', () => {
    // Both fixtures BUILD an error, or the builder discriminator would be what rejects them and
    // these two cases would pass without the rules they exist to pin.
    const rest =
      'function raise(kind: string, fix: string, ...rest: unknown[]) { throw new MyError({ code: kind, fix }); }\n' +
      "raise('X_C', 'x doctor --json');";
    const destructured =
      'function raise({ kind, fix }: { kind: string; fix: string }) { throw new MyError({ code: kind, fix }); }\n' +
      "raise({ kind: 'X_C', fix: 'x doctor --json' });";
    expect(fixes(rest)).toEqual([]);
    // The object form needs no rule of its own: the `fix:` key at the call site is already read.
    expect(fixes(destructured)).toEqual(['x doctor --json']);
  });

  test("a `{` further down the file is not this declaration's body", () => {
    // The builder discriminator reads the helper's BODY, and `bodyOf` took the next `{` anywhere
    // below it — so an expression-bodied helper that only formats a string was classified by
    // whatever object literal happened to follow. Every call to it then handed the gate a string
    // to judge as a fix, and a gate that fails on innocent source is worse than one that misses.
    const source =
      'const label = (fix: string): string => fix.trim();\n' +
      "const TITLES = { code: 'X_A' };\n" +
      "label('x db branch lst');";
    expect(fixes(source)).toEqual([]);
  });

  test('a concise arrow body is still read, so the bound did not just switch the rule off', () => {
    const source =
      "const rejected = (cause: string, fix: string): Finding => ({ code: 'X_A', cause, fix });\n" +
      "rejected('a', 'x doctor --json');";
    expect(fixes(source)).toEqual(['x doctor --json']);
  });

  test("a method call on some other object is not this file's helper", () => {
    expect(fixes(`${BUILDER}reporter.rejected('a', 'x doctor --json');`)).toEqual([]);
  });

  test('an argument that is not a sole literal has nothing to read', () => {
    expect(fixes(`${BUILDER}rejected('a', input.fix);`)).toEqual([]);
    expect(fixes(`${BUILDER}rejected('a', prefix + 'x doctor');`)).toEqual([]);
    expect(fixes(`${BUILDER}rejected('a');`)).toEqual([]);
  });

  test('the site carries the line the argument is on', () => {
    const source = `${BUILDER}rejected(\n  'a',\n  'x doctor --json',\n);`;
    expect(scanFixes(source, 'a.ts')).toEqual([{ at: 'a.ts', line: 6, fix: 'x doctor --json' }]);
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
