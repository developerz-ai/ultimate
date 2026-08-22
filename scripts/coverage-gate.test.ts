// The two halves that decide a package's verdict, driven directly: the lcov scoping that undoes
// Bun's cross-package dilution, and the ratchet that fails in both directions.

import { describe, expect, test } from 'bun:test';
import { hasExecutableCode, judge, scopeLcov, unimportedSources } from './coverage-gate';
import { COVERAGE_TARGET, PIN_SLACK } from './lib/coverage-pins';
import { repoRoot } from './lib/run';

/** Two records for the package under test, one for a package it merely imported. */
const LCOV = [
  'SF:packages/cache/src/tiers.ts',
  'FNF:10',
  'FNH:10',
  'LF:100',
  'LH:99',
  'end_of_record',
  'SF:packages/cache/src/redis.ts',
  'FNF:10',
  'FNH:9',
  'LF:100',
  'LH:98',
  'end_of_record',
  'SF:packages/core/src/logger.ts',
  'FNF:100',
  'FNH:1',
  'LF:1000',
  'LH:10',
  'end_of_record',
].join('\n');

describe('scoping an lcov report to one package', () => {
  test('a package imported by the run does not count against the package under test', () => {
    // The whole reason this gate exists: folded in, core's 1% would drag cache from 98.5% to 5%.
    expect(scopeLcov(LCOV, 'cache')).toEqual({
      pkg: 'cache',
      lines: 98.5,
      funcs: 95,
      measured: 200,
      unimported: [],
    });
  });

  test('a test file is not its own coverage', () => {
    const withTest = `${LCOV}\nSF:packages/cache/src/redis.test.ts\nFNF:50\nFNH:50\nLF:500\nLH:500\nend_of_record`;
    // Counting the test would push cache to 99.6% by measuring the tests' own execution.
    expect(scopeLcov(withTest, 'cache').measured).toBe(200);
  });

  test('an excluded path is not counted — generated glyphs are output volume, not tested surface', () => {
    const withGlyphs = `${LCOV}\nSF:packages/ui/src/icons/glyphs/a.ts\nFNF:1\nFNH:0\nLF:900\nLH:0\nend_of_record`;
    expect(scopeLcov(withGlyphs, 'ui').measured).toBe(0);
  });

  test("a tracked app's own package of the same name is NOT this package", () => {
    // `examples/dummy/packages/mcp/src/` contains `packages/mcp/src/`, so a substring test folded
    // the reference app's sources into the framework package's reading — @ultimat3/mcp measured
    // 96.99% while its own sources were at 100%, carrying 35 lines belonging to an app that is
    // gated on its own ratchet.
    const nested = `${LCOV}\nSF:examples/dummy/packages/cache/src/tools.ts\nFNF:3\nFNH:0\nLF:66\nLH:31\nend_of_record`;
    expect(scopeLcov(nested, 'cache').measured).toBe(200);
  });

  test('a report naming no file of this package measures nothing, rather than 100%', () => {
    // The false green: 0/0 is not a pass, and `judge` must be handed the zero to say so.
    expect(scopeLcov(LCOV, 'realtime')).toEqual({
      pkg: 'realtime',
      lines: 0,
      funcs: 0,
      measured: 0,
      unimported: [],
    });
  });
});

describe('a file with no lcov record at all', () => {
  test('a pure re-export barrel has no executable code — bun records none, correctly', () => {
    // `packages/money/src/index.ts` is exactly this shape. Flagging it would be noise.
    expect(
      hasExecutableCode(`/** Public surface. */
export { allocate, sum } from './arithmetic';
export type { Money } from './money';
export { type Currency, formatMoney } from './format';
`),
    ).toBe(false);
  });

  test('a module with a statement has executable code, however small', () => {
    expect(hasExecutableCode('export const ZERO = 0;\n')).toBe(true);
    expect(hasExecutableCode("import { a } from './a';\nexport const b = a();\n")).toBe(true);
  });

  test('an ambient module augmentation emits nothing', () => {
    // `packages/testing/src/matcher-surface.ts` is exactly this shape and nothing else. The inner
    // `interface` was stripped by the declaration loop, which left a bare `declare module '…' { }`
    // shell behind — non-empty, so the file read as a real module no test imports. It is the
    // opposite: an augmentation emits no runtime code, so bun writes no lcov record for it.
    expect(
      hasExecutableCode(`declare module 'bun:test' {
  interface Matchers<T> extends UltimateMatchers<T> {}
}
`),
    ).toBe(false);
    expect(
      hasExecutableCode(`declare global {
  interface Window { readonly x: number }
}
`),
    ).toBe(false);
  });

  test('an ambient block does not hide real code beside it', () => {
    // The strip must remove the block, never everything after it.
    expect(
      hasExecutableCode(`declare global {
  interface W { readonly x: 1 }
}
export const y = 2;
`),
    ).toBe(true);
  });

  test('comments alone are not executable code', () => {
    expect(hasExecutableCode('// just a note\n/* and a block */\n')).toBe(false);
  });

  test('a comment that LOOKS like a statement does not count', () => {
    // The strip runs before the check, so a commented-out export cannot resurrect a barrel.
    expect(hasExecutableCode("export { a } from './a';\n// export const x = 1;\n")).toBe(false);
  });

  test('a type alias containing an object literal is still types-only', () => {
    // The case that broke the first scanner: the `{ … }` inside the alias is not the end of the
    // declaration, so matching braces there left `, ] extends [Actor] … >;` behind — which then
    // read as executable code and reported `type-pins.ts` as an unimported module.
    expect(
      hasExecutableCode(
        'type _A = Assert<[FactKeysOf<{ a: 1 }>] extends [Actor] ? true : false>;\n',
      ),
    ).toBe(false);
  });

  test('a types-only module and a barrel are both invisible for the RIGHT reason', () => {
    expect(hasExecutableCode('export interface Counter {\n  add(n: number): void;\n}\n')).toBe(
      false,
    );
    expect(hasExecutableCode("export const COLUMN_KINDS = ['text'] as const;\n")).toBe(true);
  });

  test('an unimported file is reported, and is NOT a zero in the percentage', () => {
    // This is the whole point: bun records a file only when something imports it, so a module no
    // test reaches is absent from BOTH halves of the fraction and makes the number read higher.
    // `@ultimat3/ui` had 16 of these; its denominator grew 2,922 -> 3,286 once they were imported.
    const reading = {
      pkg: 'demo',
      lines: 99,
      funcs: 99,
      measured: 100,
      unimported: ['packages/demo/src/never-imported.ts'],
    };
    const codes = judge(reading, undefined).findings.map((f) => f.code);
    expect(codes).toContain('X_COVERAGE_UNMEASURED');
  });

  test('no unimported files is silent', () => {
    const reading = { pkg: 'demo', lines: 99, funcs: 99, measured: 100, unimported: [] };
    expect(judge(reading, undefined).findings).toEqual([]);
  });
});

describe('the ratchet', () => {
  const reading = (lines: number, funcs: number, measured = 100) => ({
    pkg: 'demo',
    lines,
    funcs,
    measured,
    unimported: [],
  });

  test('nothing measured is refused, and is not reported as being below the target', () => {
    const codes = judge(reading(0, 0, 0), undefined).findings.map((f) => f.code);
    expect(codes).toEqual(['X_COVERAGE_UNMEASURED']);
  });

  test('an unpinned package must clear the target', () => {
    expect(judge(reading(COVERAGE_TARGET, COVERAGE_TARGET), undefined).findings).toEqual([]);
    expect(judge(reading(COVERAGE_TARGET - 0.1, 99), undefined).findings[0]?.code).toBe(
      'X_COVERAGE_BELOW',
    );
  });

  test('functions are judged as well as lines — a package may pass one and fail the other', () => {
    // packages/time measured 94.6% lines against 88.67% functions, so a lines-only gate would
    // have called it green while a tenth of its functions were never called.
    expect(judge(reading(99, COVERAGE_TARGET - 1), undefined).findings[0]?.code).toBe(
      'X_COVERAGE_BELOW',
    );
  });

  test('a pinned package holds at its pin and fails below it', () => {
    const pin = { lines: 80, funcs: 80, why: 'being written' };
    expect(judge(reading(80, 80), pin).findings).toEqual([]);
    expect(judge(reading(79.9, 80), pin).findings[0]?.code).toBe('X_COVERAGE_BELOW');
  });

  test('a pin the package has outgrown is stale — the ratchet tightens, it does not become a ceiling', () => {
    const pin = { lines: 80, funcs: 80, why: 'being written' };
    expect(judge(reading(96, 96), pin).findings[0]?.code).toBe('X_COVERAGE_PIN_STALE');
    expect(judge(reading(80 + PIN_SLACK, 80 + PIN_SLACK), pin).findings[0]?.code).toBe(
      'X_COVERAGE_PIN_STALE',
    );
  });

  test('drift under the slack is not reported — one uncovered line must not fail the build twice', () => {
    const pin = { lines: 80, funcs: 80, why: 'being written' };
    expect(judge(reading(80.5, 80.5), pin).findings).toEqual([]);
  });

  test('a package over the target with no pin is silent', () => {
    expect(judge(reading(99, 99), undefined).findings).toEqual([]);
  });
});

describe('unimportedSources', () => {
  const FILE = 'packages/money/src/money.ts';

  test('an app package of the same name does not answer for the framework one', () => {
    // The collision `scopeLcov` fixed with `startsWith`, re-entered one screen below through
    // `endsWith('/' + rel)`: both tracked apps carry `packages/money/src/`, so this record used to
    // mark the FRAMEWORK file as covered and X_COVERAGE_UNIMPORTED went quiet over it.
    const lcov = `SF:examples/dummy/${FILE}\nend_of_record\n`;
    expect(unimportedSources(repoRoot(), 'money', lcov)).toContain(FILE);
  });

  test('a record for the file itself still counts, absolute or root-relative', () => {
    const root = repoRoot();
    expect(unimportedSources(root, 'money', `SF:${FILE}\nend_of_record\n`)).not.toContain(FILE);
    expect(unimportedSources(root, 'money', `SF:./${FILE}\nend_of_record\n`)).not.toContain(FILE);
    expect(unimportedSources(root, 'money', `SF:${root}/${FILE}\nend_of_record\n`)).not.toContain(
      FILE,
    );
  });
});
