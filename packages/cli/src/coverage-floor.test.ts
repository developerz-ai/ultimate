import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the fixture app is a real tree on disk.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { CoverageFloor, CoverageMeasure } from './coverage-floor';
import {
  COVERAGE_BAR,
  coverageFindings,
  FLOOR_SLACK,
  floorLine,
  judgeCoverage,
  LOSS_LIMIT,
  measureCoverage,
  readCoverageFloor,
  testPathOf,
} from './coverage-floor';
import type { CoverageMap } from './coverage-lcov';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** `apps/web/app/a.ts`: 24 of 25 lines and 24 of 25 functions — an app at 96%. */
const AT_96: CoverageMap = {
  'apps/web/app/a.ts': { hit: range(1, 24), miss: [25], funcsFound: 25, funcsHit: 24 },
};

async function withApp<T>(
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-coverage-floor-'));
  try {
    for (const [file, text] of Object.entries(files)) await Bun.write(join(root, file), text);
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const CODE = 'export const a = (): number => 1;\n';
const floor = (lines: number, funcs: number, rest: Partial<CoverageFloor> = {}): CoverageFloor => ({
  lines,
  funcs,
  exclude: [],
  ...rest,
});

describe('an app at 96%', () => {
  test('passes at a floor of 95', async () => {
    await withApp({ 'apps/web/app/a.ts': CODE }, async (root) => {
      const verdict = await judgeCoverage(root, AT_96, floor(95, 95));
      expect(verdict.measure.lines).toBe(96);
      expect(verdict.measure.funcs).toBe(96);
      expect(verdict.findings).toEqual([]);
      expect(verdict.output).toContain('96.0% of lines, 96.0% of functions over 1 source file(s)');
      expect(verdict.output).toContain('floor 95.0% / 95.0%');
    });
  });

  test('fails at a floor of 97, naming both numbers and the file that loses the lines', async () => {
    await withApp({ 'apps/web/app/a.ts': CODE }, async (root) => {
      const { findings } = await judgeCoverage(root, AT_96, floor(97, 97));
      expect(findings.map((finding) => finding.code)).toEqual(['X_COVERAGE_BELOW_FLOOR']);
      const [below] = findings;
      expect(below?.cause).toContain('96.0% of lines and 96.0% of functions');
      expect(below?.cause).toContain('97.0% / 97.0%');
      expect(below?.cause).toContain('apps/web/app/a.ts (1 of 25 lines)');
      expect(below?.at).toBe('apps/web/app/a.ts');
      // No test sits beside it in this fixture, so the fix is the file to write.
      expect(below?.fix).toStartWith('edit apps/web/app/a.test.ts — ');
      expect(below?.fix).toEndWith('bun test --coverage apps/web/app/a.test.ts');
    });
  });

  test('a route directory is a glob to a shell, so the test path is quoted in the fix', async () => {
    const page = 'apps/web/app/posts/[id]/page.tsx';
    const test = 'apps/web/app/posts/[id]/page.test.ts';
    await withApp({ [page]: CODE, [test]: '// a test\n' }, async (root) => {
      const coverage = { [page]: { hit: [1], miss: [2, 3], funcsFound: 1, funcsHit: 1 } };
      const [below] = (await judgeCoverage(root, coverage, floor(95, 95))).findings;
      expect(below?.fix).toBe(`bun test --coverage '${test}'`);
    });
  });

  test('functions are held as well as lines: one under its floor is red on its own', async () => {
    await withApp({ 'apps/web/app/a.ts': CODE }, async (root) => {
      expect((await judgeCoverage(root, AT_96, floor(95, 97))).findings).toHaveLength(1);
      expect((await judgeCoverage(root, AT_96, floor(96, 96))).findings).toEqual([]);
    });
  });

  test('with its test beside it, the fix is the command that runs it', async () => {
    await withApp(
      { 'apps/web/app/a.ts': CODE, 'apps/web/app/a.test.ts': '// a test\n' },
      async (root) => {
        const [below] = (await judgeCoverage(root, AT_96, floor(97, 97))).findings;
        expect(below?.fix).toBe('bun test --coverage apps/web/app/a.test.ts');
      },
    );
  });
});

describe('the whole source tree, not only what a test loaded', () => {
  test('a source file no test loads counts at 0% and drags the number under the floor', async () => {
    await withApp(
      {
        'apps/web/app/a.ts': CODE,
        'apps/web/app/never.ts': Array.from(
          { length: 25 },
          (_, i) => `export const v${String(i)} = (): number => ${String(i)};`,
        ).join('\n'),
      },
      async (root) => {
        const verdict = await judgeCoverage(root, AT_96, floor(95, 95));
        expect(verdict.measure.files).toBe(2);
        expect(verdict.measure.linesFound).toBe(50);
        expect(verdict.measure.lines).toBe(48);
        expect(verdict.measure.funcs).toBe(48);
        const [below] = verdict.findings;
        expect(below?.code).toBe('X_COVERAGE_BELOW_FLOOR');
        expect(below?.cause).toContain('apps/web/app/never.ts (no unit test loads it: 25 lines)');
        expect(below?.at).toBe('apps/web/app/never.ts');
      },
    );
  });

  test('a barrel, a types-only module, a test and a file outside apps/ and packages/ weigh nothing', async () => {
    await withApp(
      {
        'apps/web/app/a.ts': CODE,
        'apps/web/app/index.ts': "export { a } from './a';\n",
        'apps/web/app/types.ts': 'export interface A {\n  readonly a: number;\n}\n',
        'apps/web/app/a.test.ts': CODE,
        'scripts/seed.ts': CODE,
      },
      async (root) => {
        const measure = await measureCoverage(
          root,
          {
            ...AT_96,
            'scripts/seed.ts': { hit: [], miss: range(1, 99), funcsFound: 9, funcsHit: 0 },
          },
          undefined,
        );
        expect(measure.files).toBe(1);
        expect(measure.linesFound).toBe(25);
      },
    );
  });

  test('an excluded file is not measured — loaded or not', async () => {
    await withApp(
      { 'apps/web/app/a.ts': CODE, 'apps/web/app/mount.island.tsx': `${CODE}${CODE}` },
      async (root) => {
        const stated = floor(95, 95, {
          exclude: [{ glob: 'apps/web/**/*.island.tsx', why: 'browser-only mount' }],
        });
        expect((await judgeCoverage(root, AT_96, stated)).findings).toEqual([]);
        expect((await judgeCoverage(root, AT_96, floor(95, 95))).findings).toHaveLength(1);
      },
    );
  });

  test('the worst files come first, and a finding names at most ten of them', async () => {
    const files: Record<string, string> = {};
    const coverage: Record<string, CoverageMap[string]> = {};
    for (let i = 1; i <= 12; i += 1) {
      const file = `apps/web/app/f${String(i).padStart(2, '0')}.ts`;
      files[file] = CODE;
      coverage[file] = { hit: [], miss: range(1, i), funcsFound: 1, funcsHit: 0 };
    }
    await withApp(files, async (root) => {
      const verdict = await judgeCoverage(root, coverage, floor(95, 95));
      expect(verdict.measure.losses.map((loss) => loss.uncovered).slice(0, 3)).toEqual([
        12, 11, 10,
      ]);
      const cause = verdict.findings[0]?.cause ?? '';
      expect(cause.split('apps/web/app/f').length - 1).toBe(LOSS_LIMIT);
      expect(cause).toContain('f12.ts (12 of 12 lines)');
      expect(cause).not.toContain('f02.ts');
    });
  });
});

const measured = (lines: number, funcs: number): CoverageMeasure => ({
  lines,
  funcs,
  linesHit: 0,
  linesFound: 0,
  funcsHit: 0,
  funcsFound: 0,
  files: 3,
  losses: [],
});
const none = { exists: (): boolean => false };

describe('no floor stated', () => {
  test('is its own finding, carrying the measured numbers and the exact line to add', () => {
    const [finding, ...rest] = coverageFindings(measured(96.4, 99), undefined, none);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_COVERAGE_FLOOR_UNSTATED');
    expect(finding?.cause).toContain('96.4% of lines and 99.0% of functions');
    expect(finding?.fix).toBe('edit x.verify.json — add "coverage": { "lines": 95, "funcs": 95 }');
    expect(finding?.at).toBe('x.verify.json');
  });

  test('an app under the bar is handed its own number and owes the reason', () => {
    expect(floorLine({ lines: 59.87, funcs: 44.78 })).toBe(
      '"coverage": { "lines": 59, "funcs": 44, "why": "<what is uncovered and who closes it>" }',
    );
    expect(floorLine({ lines: 99, funcs: 94.99 })).toContain('"lines": 95, "funcs": 94, "why"');
  });
});

describe('the floor only rises', () => {
  test('a floor under the bar with no why is refused', () => {
    const findings = coverageFindings(measured(80, 80), floor(80, 80), none);
    expect(findings.map((finding) => finding.code)).toEqual(['X_COVERAGE_FLOOR_UNSTATED']);
    expect(findings[0]?.cause).toContain('80.0% / 80.0%, under the 95% bar, and no reason');
    expect(findings[0]?.fix).toContain('add "why"');
    expect(coverageFindings(measured(80, 80), floor(80, 80, { why: 'pages' }), none)).toEqual([]);
    // One number under the bar is enough to owe the reason.
    expect(coverageFindings(measured(99, 80), floor(95, 80), none)).toHaveLength(1);
  });

  test('a floor the tree has left behind is stale, per number, and names what to write', () => {
    const stale = coverageFindings(
      measured(80 + FLOOR_SLACK, 80.5),
      floor(80, 80, { why: 'pages' }),
      none,
    );
    expect(stale.map((finding) => finding.code)).toEqual(['X_COVERAGE_FLOOR_STALE']);
    expect(stale[0]?.fix).toBe(
      'edit x.verify.json — set "lines": 81 and "funcs": 80 inside "coverage"',
    );
    // Under the slack on both: one covered line must not turn the gate red.
    expect(coverageFindings(measured(81.4, 81.4), floor(80, 80, { why: 'pages' }), none)).toEqual(
      [],
    );
  });

  test('a tree that clears the bar on both retires the reason with the floor', () => {
    const [stale] = coverageFindings(measured(97, 96), floor(80, 90, { why: 'pages' }), none);
    expect(stale?.fix).toBe(
      'edit x.verify.json — set "lines": 95 and "funcs": 95 inside "coverage", and delete its "why"',
    );
    // At the bar there is nothing left to rise to: 99% over a floor of 95 is not stale.
    expect(coverageFindings(measured(99, 99), floor(COVERAGE_BAR, COVERAGE_BAR), none)).toEqual([]);
  });

  test('stale never lowers a number that is itself under its floor', () => {
    const findings = coverageFindings(measured(90, 70), floor(80, 75, { why: 'pages' }), none);
    expect(findings.map((finding) => finding.code)).toEqual([
      'X_COVERAGE_BELOW_FLOOR',
      'X_COVERAGE_FLOOR_STALE',
    ]);
    expect(findings[1]?.fix).toContain('"lines": 90 and "funcs": 75');
    // Nothing lost anywhere to name: the fix is the step that says more.
    expect(findings[0]?.fix).toBe('x verify --only unit --json');
  });
});

describe('readCoverageFloor', () => {
  test('absent is no floor and no problem', () => {
    expect(readCoverageFloor({})).toEqual({ problems: [] });
    expect(readCoverageFloor(undefined)).toEqual({ problems: [] });
  });

  test('two percentages, an optional why, and excludes that each say why', () => {
    expect(
      readCoverageFloor({
        coverage: {
          lines: 95,
          funcs: 90.5,
          why: 'pages render in e2e',
          exclude: [{ glob: 'apps/web/**/*.island.tsx', why: 'browser-only mount' }],
        },
      }),
    ).toEqual({
      coverage: {
        lines: 95,
        funcs: 90.5,
        why: 'pages render in e2e',
        exclude: [{ glob: 'apps/web/**/*.island.tsx', why: 'browser-only mount' }],
      },
      problems: [],
    });
  });

  test('a number that is not a percentage is refused — never read as a floor of nothing', () => {
    for (const lines of ['95', Number.NaN, -1, 101, null]) {
      const read = readCoverageFloor({ coverage: { lines, funcs: 95 } });
      expect(read.coverage).toBeUndefined();
      expect(read.problems.join('\n')).toContain('"coverage.lines"');
    }
    expect(readCoverageFloor({ coverage: 95 }).problems).toHaveLength(1);
    expect(readCoverageFloor({ coverage: [95, 95] }).problems).toHaveLength(1);
  });

  test('an exclude with no why excludes nothing and is named', () => {
    const read = readCoverageFloor({
      coverage: {
        lines: 95,
        funcs: 95,
        why: '',
        exclude: [
          { glob: 'apps/web/site/**' },
          { why: 'no glob' },
          'apps/**',
          { glob: 'a/**', why: 'x' },
        ],
      },
    });
    expect(read.coverage?.exclude).toEqual([{ glob: 'a/**', why: 'x' }]);
    expect(read.coverage?.why).toBeUndefined();
    expect(read.problems).toHaveLength(4);
    expect(read.problems.join('\n')).toContain('excludes apps/web/site/** with no "why"');
    expect(readCoverageFloor({ coverage: { lines: 1, funcs: 1, exclude: 'a' } }).problems).toEqual([
      '"coverage.exclude" is not a list of { "glob", "why" }',
    ]);
  });
});

test('testPathOf: the test beside a source file is `.test.ts`, for a `.tsx` too', () => {
  expect(testPathOf('apps/web/app/posts/service.ts')).toBe('apps/web/app/posts/service.test.ts');
  // Never `.test.tsx`: every generator writes `page.test.ts` beside `page.tsx`, and the registry
  // leak guard's loader covers `.test.ts` only — a fix naming the other file names one nobody writes.
  expect(testPathOf('apps/web/app/posts/page.tsx')).toBe('apps/web/app/posts/page.test.ts');
  expect(testPathOf('apps/web/app/feed/feed.island.tsx')).toBe(
    'apps/web/app/feed/feed.island.test.ts',
  );
});
