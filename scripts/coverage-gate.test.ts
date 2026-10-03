// The two halves that decide a package's verdict, driven directly: the lcov scoping that undoes
// Bun's cross-package dilution, and the ratchet that fails in both directions.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the unloaded-file fixture is a real tree on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { COVERAGE_BAR } from '../packages/cli/src/coverage-floor';
import {
  concurrency,
  judge,
  pool,
  scopeLcov,
  suiteFailure,
  unimportedSources,
  withUnloadedCounted,
} from './coverage-gate';
import { COVERAGE_PINS, COVERAGE_TARGET, PIN_SLACK } from './lib/coverage-pins';
import {
  COVERAGE_GATE_FLAGS,
  SCRIPTS_UNIT,
  shardUnits,
  unitOf,
  unitsFor,
  unitsToGate,
} from './lib/coverage-units';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms
// default — see `REPO_SCAN_TIMEOUT_MS`. A backstop, not an assertion: nothing here is meant
// to take minutes, and a test that does has hung.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

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

describe('running package suites side by side', () => {
  test('--jobs defaults to every core and refuses anything but a positive integer', () => {
    expect(concurrency(undefined)).toBe(Math.max(1, navigator.hardwareConcurrency));
    expect(concurrency('3')).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'all', '']) expect(concurrency(bad)).toBeUndefined();
  });

  test('the pool answers in input order, never in finishing order', async () => {
    const delays = [30, 0, 20, 10];
    const out = await pool(delays, 4, async (ms) => {
      await Bun.sleep(ms);
      return ms;
    });
    expect(out).toEqual(delays);
  });

  test('the pool never has more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });
});

describe('a suite that fails alone', () => {
  // The defect: the exit code was never read, so a red suite with an lcov on disk passed.
  test('a non-zero exit is X_TEST_FAILED, naming the failing tests', () => {
    const stderr = [
      'error: expect(received).toBe(expected)',
      '(pass) money > adds',
      '(fail) money > probe [0.27ms]',
    ].join('\n');
    const failure = suiteFailure('money', 1, stderr);
    expect(failure?.code).toBe('X_TEST_FAILED');
    expect(failure?.cause).toContain('(fail) money > probe');
    expect(failure?.cause).not.toContain('(pass)');
    expect(failure?.fix).toContain('bun test ./packages/money');
  });

  test('a zero exit is no failure, whatever stderr says', () => {
    expect(suiteFailure('money', 0, '(fail) not really')).toBeUndefined();
  });

  test('a hook timeout is named, and a word merely containing the phrase is not', () => {
    const cause = suiteFailure(
      'cli',
      1,
      'beforeAll timed out after 5000ms\nuntimed outcomes',
    )?.cause;
    expect(cause).toContain('beforeAll timed out after 5000ms');
    expect(cause).not.toContain('untimed outcomes');
  });
});

describe('the units --all gates', () => {
  const units = unitsToGate(repoRoot());

  test('every workspace with a src/, and scripts — sorted', () => {
    expect(units).toContain('core');
    expect(units).toContain('create-ultimate');
    expect(units).toContain(SCRIPTS_UNIT.name);
    expect([...units].sort()).toEqual([...units]);
    const packages = [
      ...new Bun.Glob('packages/*/src').scanSync({ cwd: repoRoot(), onlyFiles: false }),
    ];
    expect(units).toHaveLength(packages.length + 1);
  });

  test('scripts is measured under scripts/, a package under its own src/', () => {
    expect(unitOf('scripts')).toBe(SCRIPTS_UNIT);
    expect(unitOf('cache').source).toBe('packages/cache/src/');
    const lcov = [
      'SF:scripts/boundaries.ts',
      'FNF:4',
      'FNH:3',
      'LF:10',
      'LH:9',
      'end_of_record',
      'SF:scripts/boundaries.test.ts',
      'FNF:1',
      'FNH:0',
      'LF:90',
      'LH:0',
      'end_of_record',
      'SF:examples/dummy/scripts/test-setup.ts',
      'FNF:1',
      'FNH:0',
      'LF:90',
      'LH:0',
      'end_of_record',
    ].join('\n');
    const reading = scopeLcov(lcov, 'scripts');
    expect(reading.measured).toBe(10);
    expect(reading.lines).toBe(90);
    expect(reading.funcs).toBe(75);
    expect(judge({ ...reading, lines: 10, funcs: 10 }, undefined).findings[0]?.at).toBe('scripts');
    expect(suiteFailure('scripts', 1, '')?.fix).toContain('bun test ./scripts');
  });

  test('one bar: the target is the constant an app is held to, and a pin is under it with a reason', () => {
    expect(COVERAGE_TARGET).toBe(COVERAGE_BAR);
    for (const [name, pin] of Object.entries(COVERAGE_PINS)) {
      expect(units).toContain(name);
      expect(pin.lines < COVERAGE_TARGET || pin.funcs < COVERAGE_TARGET).toBe(true);
      expect(pin.why.trim().length).toBeGreaterThan(20);
    }
  });

  test('a scripts file no test loads counts at zero instead of vanishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-coverage-units-'));
    try {
      await Bun.write(
        join(root, 'scripts/never-loaded.ts'),
        'export const a = (): number => 1;\nexport const b = (): number => 2;\n',
      );
      const lcov = 'SF:scripts/loaded.ts\nFNF:2\nFNH:2\nLF:2\nLH:2\nend_of_record\n';
      const scoped = {
        ...scopeLcov(lcov, 'scripts'),
        unimported: unimportedSources(root, 'scripts', lcov),
      };
      expect(scoped.lines).toBe(100);
      expect(scoped.unimported).toEqual(['scripts/never-loaded.ts']);
      const counted = withUnloadedCounted(root, scoped, lcov);
      expect(counted.unimported).toEqual([]);
      expect(counted.measured).toBe(4);
      expect(counted.lines).toBe(50);
      expect(counted.funcs).toBe(50);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('--shard i/n', () => {
  const units = unitsToGate(repoRoot());

  for (const total of [2, 3]) {
    test(`every unit is in exactly one shard of ${String(total)}`, () => {
      const shards = Array.from({ length: total }, (_, i) =>
        shardUnits(units, `${String(i + 1)}/${String(total)}`),
      );
      expect(shards.flat().sort()).toEqual([...units]);
      expect(new Set(shards.flat()).size).toBe(units.length);
      // Round-robin: no shard is more than one unit larger than another.
      const sizes = shards.map((shard) => shard.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    });
  }

  test('round-robin over the SORTED list, whatever order it arrives in', () => {
    expect(shardUnits(['c', 'a', 'd', 'b'], '1/2')).toEqual(['a', 'c']);
    expect(shardUnits(['c', 'a', 'd', 'b'], '2/2')).toEqual(['b', 'd']);
  });

  test('a spec that is not i/n with 1 <= i <= n is refused with a command that runs', () => {
    for (const raw of ['0/2', '3/2', '1', 'a/b', '', '1/0']) {
      try {
        shardUnits(units, raw);
        expect.unreachable(`"${raw}" was accepted`);
      } catch (error) {
        expect(error).toMatchObject({
          code: 'X_CLI_BAD_FLAG',
          fix: 'bun run scripts/coverage-gate.ts --all --shard 1/2',
        });
      }
    }
  });
});

describe('the flags the gate reads', () => {
  const root = repoRoot();
  const flags = (
    entries: Record<string, string | boolean>,
  ): ReadonlyMap<string, string | boolean> => new Map(Object.entries(entries));
  const refusal = (entries: Record<string, string | boolean>): unknown => {
    try {
      unitsFor(root, flags(entries));
    } catch (error) {
      return error;
    }
    return expect.unreachable(`${JSON.stringify(entries)} was accepted`);
  };

  test('--package names one unit, --all every one, --all --shard a share', () => {
    expect(unitsFor(root, flags({ package: 'core', json: true }))).toEqual(['core']);
    expect(unitsFor(root, flags({ all: true }))).toEqual(unitsToGate(root));
    expect(unitsFor(root, flags({ all: true, shard: '2/2', jobs: '2' }))).toEqual(
      shardUnits(unitsToGate(root), '2/2'),
    );
  });

  test('--all given a value is refused, never read as off', () => {
    const refused = refusal({ all: 'false' }) as { code: string; cause: string; fix: string };
    expect(refused.code).toBe('X_CLI_BAD_FLAG');
    expect(refused.cause).toContain('--all takes no value');
    expect(refused.fix).toBe('bun run scripts/coverage-gate.ts --all');
  });

  test('an unknown flag is refused, never dropped', () => {
    expect(COVERAGE_GATE_FLAGS).toContain('shard');
    expect(refusal({ all: true, shrad: '1/2' })).toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'bun run scripts/coverage-gate.ts --all',
    });
  });

  test('--shard without --all, neither flag, both flags and a bare --shard are refused', () => {
    expect(refusal({ package: 'core', shard: '1/2' })).toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'bun run scripts/coverage-gate.ts --all --shard 1/2',
    });
    expect(refusal({})).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(refusal({ package: true })).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(refusal({ package: 'core', all: true })).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(refusal({ all: true, shard: true })).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
  });
});
