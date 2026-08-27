// The failure case first: a package pinned green whose tests gain an error. Then the mirror image
// — a package repaired and never unpinned — because a ratchet that only tightens in one direction
// rots, and the four ways this rule could report a false green: a pin for a package that is gone,
// a compile that never ran, a `--unpin` that RAISES a count, and a second declaration of the
// matcher surface that would let the two drift apart.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { TestDiagnostic } from './lib/test-typecheck';
import { TESTS_TSCONFIG } from './lib/test-typecheck';
import { PINS_FILE, TEST_TYPECHECK_PINS } from './lib/test-typecheck-pins';
import { packageDirs } from './list-package-dirs';
import {
  checkTestTypecheck,
  testTypecheckFindingFor,
  unpinCommand,
  unpinnedSource,
} from './test-typecheck-gate';

const at = (pkg: string, line = 12): TestDiagnostic => ({
  file: `packages/${pkg}/src/thing.test.ts`,
  line,
  code: 2304,
  text: 'Cannot find name Foo.',
});

const input = (
  over: Partial<Parameters<typeof checkTestTypecheck>[0]>,
): Parameters<typeof checkTestTypecheck>[0] => ({
  packages: ['money', 'entity'],
  diagnostics: [],
  counts: {},
  pins: { money: 0, entity: 2 },
  ...over,
});

describe('a package whose tests carry more errors than it is pinned at', () => {
  test('a package pinned GREEN gaining one error is the finding', () => {
    const gaps = checkTestTypecheck(
      input({ diagnostics: [at('money', 40)], counts: { money: 1, entity: 2 } }),
    );
    expect(gaps.map((gap) => gap.kind)).toEqual(['over']);
    const finding = testTypecheckFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_TEST_TYPECHECK_REGRESSED');
    // The file and line the compiler named, not the pins file: the edit is in the test.
    expect(finding.at).toBe('packages/money/src/thing.test.ts:40');
    expect(finding.cause).toContain('Cannot find name Foo.');
  });

  test('a package with no pin at all must typecheck — absent means zero', () => {
    const gaps = checkTestTypecheck(
      input({ packages: ['fresh'], pins: {}, counts: { fresh: 3 }, diagnostics: [at('fresh')] }),
    );
    expect(gaps.map((gap) => gap.kind)).toEqual(['over']);
  });

  test('at the pin holds, and so does under it — under is reported separately', () => {
    expect(checkTestTypecheck(input({ counts: { entity: 2 } }))).toEqual([]);
  });
});

describe('the ratchet only tightens', () => {
  test('a package repaired and left pinned is a finding, and the fix is one command', () => {
    const gaps = checkTestTypecheck(input({ counts: { entity: 0 } }));
    expect(gaps.map((gap) => gap.kind)).toEqual(['stale']);
    const finding = testTypecheckFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_TEST_TYPECHECK_PIN_STALE');
    expect(finding.fix).toBe('bun run scripts/test-typecheck-gate.ts --unpin entity');
    expect(finding.at).toBe(PINS_FILE);
  });

  test('a pin for a package that is not on disk excuses nothing', () => {
    const gaps = checkTestTypecheck(input({ pins: { money: 0, gone: 9 } }));
    expect(gaps.map((gap) => gap.kind)).toEqual(['orphan']);
    expect(testTypecheckFindingFor(gaps[0] as never).fix).toBe(unpinCommand(['gone']));
  });
});

describe('a run that compiled nothing is never green', () => {
  test('tsc refusing to start is the finding, not silence', () => {
    const gaps = checkTestTypecheck(input({ unscanned: 'error TS18003: No inputs were found' }));
    expect(gaps.map((gap) => gap.kind)).toEqual(['unscanned']);
    const finding = testTypecheckFindingFor(gaps[0] as never);
    expect(finding.code).toBe('X_TEST_TYPECHECK_UNSCANNED');
    expect(finding.at).toBe(TESTS_TSCONFIG);
  });

  test('no package directory at all is the same false green', () => {
    expect(checkTestTypecheck(input({ packages: [] }))[0]?.kind).toBe('unscanned');
  });
});

const SOURCE = [
  'export const TEST_TYPECHECK_PINS: Readonly<Record<string, number>> = {',
  '  entity: 78,',
  "  'create-ultimate': 0,",
  '  ghost: 4,',
  '};',
  '',
].join('\n');

describe('--unpin, performed', () => {
  test('lowers a count to what is measured', () => {
    const next = unpinnedSource(SOURCE, ['entity'], { entity: 40 }, ['entity', 'create-ultimate']);
    expect(next).toContain('  entity: 40,');
  });

  test('never RAISES one — that is a hand edit, in a review', () => {
    const next = unpinnedSource(SOURCE, ['entity'], { entity: 500 }, ['entity']);
    expect(next).toContain('  entity: 78,');
  });

  test('a package that is gone loses its line rather than being pinned at zero', () => {
    const next = unpinnedSource(SOURCE, ['ghost'], {}, ['entity', 'create-ultimate']);
    expect(next).not.toContain('ghost');
    expect(next).toContain('  entity: 78,');
  });

  test('a quoted key is the same line', () => {
    const next = unpinnedSource(SOURCE, ['create-ultimate'], {}, ['create-ultimate']);
    expect(next).toContain("  'create-ultimate': 0,");
  });

  test('a name with no line it can read rewrites nothing at all', () => {
    expect(unpinnedSource(SOURCE, ['entity', 'nosuch'], { entity: 0 }, ['entity'])).toBeUndefined();
    expect(unpinnedSource('const other = {};', ['entity'], {}, ['entity'])).toBeUndefined();
  });

  test('a name that is not a package name is never compiled into a pattern', () => {
    // `.*` would otherwise match all thirty lines and rewrite every one of them to zero.
    expect(unpinnedSource(SOURCE, ['.*'], {}, ['entity'])).toBeUndefined();
  });
});

describe('the table and the program describe this repo', () => {
  test('every pinned name is a package directory', () => {
    const dirs = packageDirs(repoRoot());
    expect(Object.keys(TEST_TYPECHECK_PINS).filter((pkg) => !dirs.includes(pkg))).toEqual([]);
  });

  test(
    'the program reads the test files the package configs exclude, and the e2e dirs they never had',
    async () => {
      const config = (await Bun.file(join(repoRoot(), TESTS_TSCONFIG)).json()) as {
        readonly compilerOptions: Record<string, unknown>;
        readonly include: readonly string[];
      };
      expect(config.include).toContain('packages/*/src/**/*.test.ts');
      expect(config.include).toContain('packages/*/e2e/**/*.ts');
      // `noEmit` is the whole reason this is a second program rather than a dropped `exclude`:
      // the package configs are composite, so compiling a test there writes it into dist/.
      expect(config.compilerOptions['noEmit']).toBe(true);
      expect(config.compilerOptions['composite']).toBe(false);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test(
    'every package config still EXCLUDES its tests, so no test is emitted into dist/',
    async () => {
      const offenders: string[] = [];
      for (const pkg of packageDirs(repoRoot())) {
        const path = `packages/${pkg}/tsconfig.json`;
        const config = (await Bun.file(join(repoRoot(), path)).json()) as {
          readonly exclude?: readonly string[];
        };
        if (!(config.exclude ?? []).includes('src/**/*.test.ts')) offenders.push(path);
      }
      // Dropping the exclusion is the OTHER way to typecheck a test, and it is the wrong one:
      // these configs are `composite`, so it writes every test into that package's dist/. The
      // exclusion staying put is what makes `tsconfig.tests.json` the one way to do this.
      expect(offenders).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );

  test(
    'the matcher surface is declared in exactly ONE file, and it is not matchers.ts',
    async () => {
      const declaring: string[] = [];
      for await (const path of new Bun.Glob('packages/*/src/**/*.ts').scan({ cwd: repoRoot() })) {
        const text = await Bun.file(join(repoRoot(), path)).text();
        if (text.includes("declare module 'bun:test'")) declaring.push(path);
      }
      expect(declaring).toEqual(['packages/testing/src/matcher-surface.ts']);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
