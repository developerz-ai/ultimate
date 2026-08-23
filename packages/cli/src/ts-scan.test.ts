import { describe, expect, test } from 'bun:test';
import {
  isCodeRegistry,
  maskLiterals,
  scanBorrowedCodes,
  scanCodeDeclarations,
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
    expect(stripComments("const url = 'https://example.com/x';")).toContain(
      'https://example.com/x',
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

// Issue #277: `const STALE = 'X_…'` and then `code: STALE` is what a DRY author writes, and the
// scan read a string literal only — so the manifest, the wiki check and `bun run gate-codes` were
// all blind to the code, silently and in the permissive direction. `scripts/package-map-graph.ts`
// shipped exactly that shape. Resolution and refusal are one pass, so no reader can see less.
describe('scanCodeDeclarations · a code behind an identifier', () => {
  test('resolves a module-scope const declared in the same file', () => {
    const source = ["const STALE = 'X_DOC_STALE';", "raise({ code: STALE, fix: 'x help' });"].join(
      '\n',
    );
    expect(scanCodes(source, 'scripts/graph.ts')).toEqual([
      { at: 'scripts/graph.ts', line: 2, code: 'X_DOC_STALE' },
    ]);
    expect(scanCodeDeclarations(source, 'scripts/graph.ts').unresolved).toEqual([]);
  });

  test('resolves it exported, annotated, and frozen with `as const`', () => {
    const source = [
      "export const A: string = 'X_A';",
      "const B = 'X_B' as const;",
      'raise({ code: A });',
      'raise({ code: B });',
    ].join('\n');
    expect(
      scanCodes(source, 'a.ts')
        .map((site) => site.code)
        .sort(),
    ).toEqual(['X_A', 'X_B']);
  });

  // The whole point of the change: an identifier the scan cannot resolve is REPORTED, never
  // skipped. Skipping it is what let a real code ship undocumented under a green gate.
  test('an identifier no module-scope const in this file gives a value is a finding', () => {
    const scan = scanCodeDeclarations(
      "import { STALE } from './codes';\nraise({ code: STALE });",
      'a.ts',
    );
    expect(scan.sites).toEqual([]);
    expect(scan.unresolved).toEqual([{ at: 'a.ts', line: 2, name: 'STALE' }]);
  });

  // Measured over the framework and both tracked apps: one site, `packages/realtime/src/nats-fake.ts`,
  // where `code: STATUS_NOT_FOUND` is a NATS status number. Resolving to a non-code is an ANSWER,
  // so it is neither a declaration nor a finding — a rule that reported it would be argued with.
  test('an identifier that resolves to something that is not a code is neither', () => {
    const scan = scanCodeDeclarations(
      'const STATUS_NOT_FOUND = 404;\nsend({ code: STATUS_NOT_FOUND });',
      'n.ts',
    );
    expect(scan.sites).toEqual([]);
    expect(scan.unresolved).toEqual([]);
  });

  // A table read is how `@ultimat3/seo` and `@ultimat3/ui` raise every one of their codes, and the
  // registry branch already collects those literals. Judging the read would report 18 working sites.
  test('a table read, an index and a call are not judged', () => {
    const scan = scanCodeDeclarations(
      [
        'raise({ code: SEO_ERROR_CODES.metaMissing });',
        'raise({ code: TABLE[kind] });',
        'raise({ code: CODE_OF(row) });',
      ].join('\n'),
      'seo.ts',
    );
    expect(scan.sites).toEqual([]);
    expect(scan.unresolved).toEqual([]);
  });

  // 164 lowercase identifiers sit at a `code:` position in this tree and every one of them is a
  // type annotation or a re-raise — `readonly code: string`, `code: opts.code`. A code CONSTANT is
  // SCREAMING_SNAKE by house convention, so that is the only shape the refusal is aimed at.
  test('a type annotation and a lowercase value are not findings', () => {
    const source = [
      'interface Finding {',
      '  readonly code: string;',
      '}',
      'raise({ code: kind });',
    ].join('\n');
    expect(scanCodeDeclarations(source, 'a.ts').unresolved).toEqual([]);
  });

  // A member ASSIGNMENT is a projection of somebody else's code, never a declaration of one. The
  // resolvable site sits in the same file deliberately: without it the whole file is skipped by
  // the cheap probe, and the rule that is really under test here never runs.
  test('`site.code = NAME` is not a declaration and not a finding', () => {
    const source = [
      "const STALE = 'X_A';",
      'raise({ code: STALE });',
      'found.code = SOMETHING;',
    ].join('\n');
    const scan = scanCodeDeclarations(source, 'a.ts');
    expect(scan.sites).toEqual([{ at: 'a.ts', line: 2, code: 'X_A' }]);
    expect(scan.unresolved).toEqual([]);
  });

  // `packages/cli/src/templates/` emits a generated app's source by the dozen inside template
  // literals. Read as code, a template that writes a throw site would declare the app's codes here.
  test('a `code:` inside a template literal is text, not a declaration', () => {
    const source = ["const STALE = 'X_A';", 'export const t = `raise({ code: STALE });`;'].join(
      '\n',
    );
    const scan = scanCodeDeclarations(source, 'packages/cli/src/templates/app.ts');
    expect(scan.sites).toEqual([]);
    expect(scan.unresolved).toEqual([]);
  });

  test('a literal is still read, and still wins where both are written', () => {
    const source = [
      "const STALE = 'X_A';",
      "raise({ code: 'X_A' });",
      'raise({ code: STALE });',
    ].join('\n');
    expect(scanCodes(source, 'a.ts')).toEqual([{ at: 'a.ts', line: 2, code: 'X_A' }]);
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
      "import { CLI_ERROR_TITLES } from './error-codes';",
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
