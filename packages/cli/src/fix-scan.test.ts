// Three shapes a `fix:` arrives in, one describe each: under a key, positionally at a local error
// builder's parameter, and at an error class constructor's — plus the same builder resolved from
// another file. Each gap shipped stale lines the gate could not see: `@ultimat3/mcp`'s two
// `x db branch <name>` through the positional helper, `@ultimat3/ui`'s four through the imported one.

import { describe, expect, test } from 'bun:test';
import { scanFixes, scanFixSites } from './fix-scan';

const fixes = (source: string): readonly string[] =>
  scanFixes(source, 'a.ts').map((site) => site.fix);

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

/**
 * The third shape. `@ultimat3/render`'s `errors.ts` declares fourteen error classes taking
 * `(cause, fix)` positionally and `@ultimat3/core`'s image pipeline three more; a scan that reads
 * only functions read none of their fix lines, and 15 of render's codes had never had one checked.
 */
describe('scanFixes · a fix passed positionally into an error class', () => {
  const CLASS =
    'export class RouteModeInvalidError extends UltimateError {\n' +
    "  static readonly code = 'X_ROUTE_MODE_INVALID' as const;\n" +
    '  constructor(cause: string, fix: string) {\n' +
    '    super({ code: RouteModeInvalidError.code, cause, fix });\n' +
    '  }\n' +
    '}\n';

  test('reads the argument in the constructor fix position', () => {
    expect(fixes(`${CLASS}throw new RouteModeInvalidError('static read the request', 'x help');`)) //
      .toEqual(['x help']);
  });

  test('the helper is the CLASS name and the position is the constructor’s', () => {
    const source =
      'class Fail extends UltimateError {\n' +
      '  constructor(field: string, fix: string, meta: object) {\n' +
      "    super({ code: 'X_B', cause: field, fix });\n" +
      '  }\n' +
      '}\n' +
      "new Fail('amount', 'x g migration money', { a: 1 });";
    expect(fixes(source)).toEqual(['x g migration money']);
  });

  // Same discriminator as the function form: a class that merely carries a fix is not one that
  // builds an error, and reading its call sites would report findings about judged strings.
  test('a class whose constructor builds no error is not a helper', () => {
    const source =
      'class Advice {\n' +
      '  constructor(cause: string, fix: string) {\n' +
      '    this.text = cause.concat(fix);\n' +
      '  }\n' +
      '}\n' +
      "new Advice('a', 'x db branch lst');";
    expect(fixes(source)).toEqual([]);
  });

  test('a class with no constructor at all declares nothing', () => {
    const source =
      "class Plain extends UltimateError { static readonly code = 'X_C' as const; }\n" +
      "new Plain('x db branch lst');";
    expect(fixes(source)).toEqual([]);
  });
});

/**
 * The blind spot #157 names: a helper declared in a SIBLING module. `fix-imports.ts` resolves the
 * specifier and hands the table in — this is the half that reads a call site against it.
 */
describe('scanFixes · a helper resolved from another file', () => {
  const IMPORTED = [{ name: 'invalidIconData', index: 1 }] as const;

  test('reads the argument at the imported position', () => {
    const source = "invalidIconData('parsed as null', 'x doctor --json');";
    expect(scanFixes(source, 'a.ts', IMPORTED)).toEqual([
      { at: 'a.ts', line: 1, fix: 'x doctor --json' },
    ]);
  });

  // A file that declares the name itself is calling ITS OWN function, whatever it also imports —
  // and reading both tables would report one argument twice, at two different positions.
  test('a local declaration of the same name wins over the imported one', () => {
    const source =
      "function invalidIconData(fix: string, cause: string) { throw new E({ code: 'X_A', fix }); }\n" +
      "invalidIconData('x doctor --json', 'parsed as null');";
    expect(scanFixes(source, 'a.ts', IMPORTED).map((site) => site.fix)).toEqual([
      'x doctor --json',
    ]);
  });

  test('an unreadable argument is counted rather than dropped', () => {
    expect(scanFixSites("invalidIconData('a', input.fix);", 'a.ts', IMPORTED)).toEqual({
      sites: [],
      unreadable: 1,
    });
    // One argument short is not an unreadable fix: nothing was written there to read.
    expect(scanFixSites("invalidIconData('a');", 'a.ts', IMPORTED).unreadable).toBe(0);
  });
});
