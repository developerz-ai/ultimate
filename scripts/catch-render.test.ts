// The rule's own evidence: the shapes it must report, the shapes it must stay silent about, and
// the ratchet's two directions. The first test is the one that matters — it is the exact source
// `scripts/error-render.ts` was measured GREEN over, before and after a seven-site fix.

import { describe, expect, test } from 'bun:test';
import {
  type CatchRenderSite,
  catchRenderFindingFor,
  checkCatchRenders,
  launderedByPackage,
  launderedFields,
  scanCatchRenders,
} from './catch-render';
import { checkErrorRendering } from './error-render';

const kinds = (source: string): readonly string[] =>
  scanCatchRenders('packages/x/src/a.ts', source).map(
    (site) => `${site.field}:${site.binding}:${site.kind}`,
  );

/** The shipped shape, verbatim — the one thirteen hand fixes removed and nothing was watching. */
const DUCK_TYPED = [
  'export function read(text: string): string {',
  '  try {',
  '    return JSON.parse(text) as string;',
  '  } catch (error) {',
  '    throw new UltimateError({',
  '      code: "X_BAD",',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
  '      cause: `it did not parse: ${error instanceof Error ? error.message : String(error)}`,',
  '      fix: "run x doctor",',
  '    });',
  '  }',
  '}',
].join('\n');

describe('unit · a caught value reaching a refusal is reported', () => {
  test('the duck-typed catch that the parameter rule cannot see, and this one can', () => {
    // The finding, and the proof it is a NEW one: the same source through the shipped check is
    // silent, because `UNKNOWN_BINDING` matches an annotation and a catch binding carries none.
    expect(kinds(DUCK_TYPED)).toEqual(['cause:error:instanceof']);
    expect(checkErrorRendering([{ path: 'packages/x/src/a.ts', source: DUCK_TYPED }])).toEqual([]);
  });

  test('each of the four mechanisms, one per field', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    expect(kinds('try { a(); } catch (e) { throw new E({ cause: `boom ${e}` }); }')).toEqual([
      'cause:e:interpolation',
    ]);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
      kinds('try { a(); } catch (e) { throw new E({ fix: `re-run: ${String(e)}` }); }'),
    ).toEqual(['fix:e:conversion']);
    expect(kinds('try { a(); } catch (e) { throw new E({ detail: JSON.stringify(e) }); }')).toEqual(
      ['detail:e:stringify'],
    );
    expect(
      kinds('try { a(); } catch (e) { throw new E({ cause: e instanceof Error ? 1 : 2 }); }'),
    ).toEqual(['cause:e:instanceof']);
  });

  test('one line, one site — two mechanisms in one ternary are one repair', () => {
    const both =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
      'try { a(); } catch (e) { throw new E({ cause: `${e instanceof Error ? e.message : String(e)}` }); }';
    expect(scanCatchRenders('packages/x/src/a.ts', both)).toHaveLength(1);
  });

  test('a file-local duck renderer is a String() call with a name in front', () => {
    const laundered = [
      'const messageOf = (error: unknown): string =>',
      '  error instanceof Error ? error.message : String(error);',
      'export function read(): void {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
      '  try { parse(); } catch (error) { throw new E({ cause: `bad: ${messageOf(error)}` }); }',
      '}',
    ].join('\n');
    expect(kinds(laundered)).toEqual(['cause:error:conversion']);
  });
});

describe('unit · what the rule stays silent about', () => {
  test('renderThrowable is the repair, so it is not a finding', () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
      kinds('try { a(); } catch (e) { throw new E({ cause: `bad: ${renderThrowable(e)}` }); }'),
    ).toEqual([]);
  });

  test('a narrowed property read is a string by then, and reporting it would report narrowing', () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
      kinds('try { a(); } catch (e) { throw new E({ cause: `bad: ${e.message}` }); }'),
    ).toEqual([]);
  });

  test('a catch that renders nothing into a refusal, and a bare catch that binds nothing', () => {
    expect(kinds('try { a(); } catch (e) { log(e); }')).toEqual([]);
    expect(
      kinds('try { a(); } catch { throw new E({ cause: "it failed", fix: "retry" }); }'),
    ).toEqual([]);
  });

  test('a field OUTSIDE the catch block is another statement, not this one', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    const after = 'try { a(); } catch (e) { log(e); }\nthrow new E({ cause: `${e}` });';
    expect(kinds(after)).toEqual([]);
  });

  test('the words in a comment or a string are not code — the mask blanks both', () => {
    const quoted = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
      '// catch (error) { cause: `${String(error)}` } is the shape this rule reports',
      'export const advice = "catch (error) { cause: String(error) }";',
    ].join('\n');
    expect(kinds(quoted)).toEqual([]);
  });
});

describe('unit · the ratchet moves in one direction', () => {
  const site = (path: string): CatchRenderSite => ({
    path,
    line: 3,
    field: 'cause',
    binding: 'error',
    kind: 'instanceof',
  });
  const file = (path: string) => ({ path, source: DUCK_TYPED });

  test('a package over its pin is reported, with a runnable repair', () => {
    const gaps = checkCatchRenders({ files: [file('packages/x/src/a.ts')], pins: {} });
    expect(gaps.map((gap) => `${gap.kind}:${gap.pkg}:${String(gap.found)}`)).toEqual(['over:x:1']);
    const finding = catchRenderFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_CATCH_RENDER_UNSAFE');
    expect(finding.fix).toContain('renderThrowable(error)');
  });

  test('a package AT its pin is silent, and one below it is a stale pin to lower', () => {
    expect(checkCatchRenders({ files: [file('packages/x/src/a.ts')], pins: { x: 1 } })).toEqual([]);
    const stale = checkCatchRenders({ files: [file('packages/x/src/a.ts')], pins: { x: 3 } });
    expect(stale.map((gap) => gap.kind)).toEqual(['stale']);
    expect(catchRenderFindingFor(stale[0] as never).code).toBe('X_CATCH_RENDER_PIN_STALE');
  });

  test('an empty file set is UNSCANNED, never a clean tree', () => {
    const gaps = checkCatchRenders({ files: [], pins: { x: 1 } });
    expect(gaps.map((gap) => gap.kind)).toEqual(['unscanned']);
    expect(catchRenderFindingFor(gaps[0] as never).code).toBe('X_CATCH_RENDER_UNSCANNED');
  });

  /**
   * `at` is what review tooling anchors on, so a finding whose `at` names a file its own `fix:`
   * never edits sends the reader to the wrong place. Asserted as the two agreeing, rather than as
   * one literal, because the pair is the rule.
   */
  test('the UNSCANNED finding anchors on the file its fix edits', () => {
    const finding = catchRenderFindingFor(checkCatchRenders({ files: [], pins: {} })[0] as never);
    expect(finding.at).toBe('scripts/lib/corpus.ts');
    expect(finding.fix).toContain('scripts/lib/corpus.ts');
  });

  test('a test file is in nobody`s shipped path and is not counted', () => {
    expect(checkCatchRenders({ files: [file('packages/x/src/a.test.ts')], pins: {} })).toEqual([]);
    expect(site('packages/x/src/a.ts').path).toBe('packages/x/src/a.ts');
  });
});
describe('the destinations the rule name promised and the list did not have', () => {
  /**
   * `packages/admin/src/action-gate.ts:186` — `trace:` was not one of the three names, so an
   * `AdminDecision` rendering a caught value with `String(error)` passed under a green gate. The
   * shape below is that line, reduced.
   */
  test('a caught value rendered into `trace:` is reported', () => {
    expect(kinds('try { a(); } catch (error) { return { trace: [String(error)] }; }')).toEqual([
      'trace:error:conversion',
    ]);
  });

  test('and `cause`, `fix` and `detail` still are, so the widening added rather than replaced', () => {
    expect(kinds('try { a(); } catch (e) { throw new E({ detail: String(e) }); }')).toEqual([
      'detail:e:conversion',
    ]);
  });
});

describe('one hop: a field this package own errors.ts launders into a refusal', () => {
  const ERRORS = [
    'export class IslandBuildFailedError extends UltimateError {',
    '  constructor(input: { file: string; logs: string }) {',
    '    super({',
    '      code: "X_ISLAND_BUILD_FAILED",',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    '      cause: `${input.file} would not bundle: ${input.logs}`,',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    '      fix: `bun build --target browser ${input.file}`,',
    '    });',
    '  }',
    '}',
  ].join('\n');

  test('the field names are read off errors.ts, dotted ones only', () => {
    const fields = launderedFields(ERRORS);
    expect([...fields].sort()).toEqual(['file', 'logs']);
  });

  test('a refusal field is never re-listed as a laundered one', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    expect([...launderedFields('const e = { cause: `${input.cause}` };')]).toEqual([]);
  });

  /** `packages/cli/src/island-bundle.ts:94`, reduced: `String(error)` into a `string`-typed field. */
  test('a caught value written into that field, one file away, is reported', () => {
    const site = scanCatchRenders(
      'packages/cli/src/island-bundle.ts',
      'try { a(); } catch (error) { throw new IslandBuildFailedError({ file, logs: String(error) }); }',
      launderedFields(ERRORS),
    );
    expect(site.map((one) => `${one.field}:${one.binding}:${one.kind}`)).toEqual([
      'logs:error:conversion',
    ]);
  });

  test('and is silent without the hop, which is what the two rules used to be', () => {
    expect(
      scanCatchRenders(
        'packages/cli/src/island-bundle.ts',
        'try { a(); } catch (error) { throw new E({ file, logs: String(error) }); }',
      ),
    ).toEqual([]);
  });

  /**
   * The line this rule refuses to report, and the reason the laundered pattern demands a `:`.
   * `packages/cli/src/verify-floor.ts:46` binds a local `const reason` whose name collides with
   * `FlagInvalidError`'s `input.reason` in the same package. A name matching in an unrelated place
   * is not evidence — the exact mistake `scripts/config-readers.ts` was repaired for the same day.
   */
  test('a local binding sharing a laundered field name is a collision, not a hop', () => {
    expect(
      scanCatchRenders(
        'packages/cli/src/verify-floor.ts',
        'try { a(); } catch (error) { const reason = error instanceof Error ? error.message : String(error); return reason; }',
        new Set(['reason']),
      ),
    ).toEqual([]);
  });

  test('the laundered set is per package, keyed off that package own errors.ts', () => {
    const map = launderedByPackage([
      { path: 'packages/cli/src/errors.ts', source: ERRORS },
      { path: 'packages/cli/src/island-bundle.ts', source: 'const a = 1;' },
      { path: 'packages/ai/src/other.ts', source: ERRORS },
    ]);
    expect([...(map.get('cli') ?? [])].sort()).toEqual(['file', 'logs']);
    expect(map.has('ai')).toBe(false);
  });
});
