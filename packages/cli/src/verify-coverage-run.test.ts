import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the fixture app is a real tree `bun test` runs in.
import { existsSync } from 'node:fs';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { measureCoverage } from './coverage-floor';
import type { Runner } from './exec';
import { exec } from './exec';
import {
  COVERAGE_DIR,
  COVERAGE_SLICE_FILES,
  coverageSlices,
  coveredArgs,
  runCovered,
} from './verify-coverage-run';

describe('coverageSlices', () => {
  test('a directory stays in one slice, and slices fill in sorted order up to the cap', () => {
    const files = [
      'apps/web/app/posts/b.test.ts',
      'apps/web/app/feed/a.test.ts',
      'apps/web/app/posts/a.test.ts',
      'apps/web/app/feed/b.test.ts',
      'packages/db/src/x.test.ts',
    ];
    expect(coverageSlices(files, 4)).toEqual([
      ['apps/web/app/feed/a.test.ts', 'apps/web/app/feed/b.test.ts'].concat([
        'apps/web/app/posts/a.test.ts',
        'apps/web/app/posts/b.test.ts',
      ]),
      ['packages/db/src/x.test.ts'],
    ]);
    // Three would split `posts` from `feed` rather than cut either directory in two.
    expect(coverageSlices(files, 3)).toEqual([
      ['apps/web/app/feed/a.test.ts', 'apps/web/app/feed/b.test.ts'],
      ['apps/web/app/posts/a.test.ts', 'apps/web/app/posts/b.test.ts', 'packages/db/src/x.test.ts'],
    ]);
  });

  test('only a directory larger than the cap is cut', () => {
    const big = Array.from({ length: 5 }, (_, i) => `apps/web/app/big/t${String(i)}.test.ts`);
    expect(coverageSlices(['a/first.test.ts', ...big, 'z/last.test.ts'], 2)).toEqual([
      ['a/first.test.ts'],
      big.slice(0, 2),
      big.slice(2, 4),
      big.slice(4),
      ['z/last.test.ts'],
    ]);
  });

  test('a pure function of the file SET: order and duplicates change nothing', () => {
    const files = ['b/2.test.ts', 'a/1.test.ts', 'b/1.test.ts'];
    expect(coverageSlices([...files].reverse())).toEqual(coverageSlices([...files, 'a/1.test.ts']));
    expect(coverageSlices([])).toEqual([]);
    expect(COVERAGE_SLICE_FILES).toBeGreaterThan(1);
  });
});

test('coveredArgs: lcov into the slice’s own directory, the explicit files last', () => {
  expect(coveredArgs(['a.test.ts', 'b.test.ts'], '/tmp/c/0', false)).toEqual([
    'bun',
    'test',
    '--coverage',
    '--coverage-reporter=lcov',
    '--coverage-dir=/tmp/c/0',
    'a.test.ts',
    'b.test.ts',
  ]);
  expect(coveredArgs(['a.test.ts'], '/tmp/c/0', true)).toContain('--isolate');
});

/** A two-directory app: `double` is called by one test and only LOADED by the other. */
async function fixtureApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-covered-run-'));
  await Bun.write(
    join(root, 'apps/web/app/math.ts'),
    [
      'export function double(n: number): number {',
      '  // doubled, never squared',
      '  return n * 2;',
      '}',
      'export function never(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
  );
  await Bun.write(
    join(root, 'apps/web/app/math.test.ts'),
    "import { expect, test } from 'bun:test';\nimport { double } from './math';\ntest('doubles', () => {\n  expect(double(2)).toBe(4);\n});\n",
  );
  await Bun.write(
    join(root, 'apps/web/site/loads.test.ts'),
    "import { expect, test } from 'bun:test';\nimport * as math from '../app/math';\ntest('loads', () => {\n  expect(typeof math.double).toBe('function');\n});\n",
  );
  await Bun.write(
    join(root, 'apps/web/app/unloaded.ts'),
    'export const answer = (): number => 42;\n',
  );
  return root;
}

describe('runCovered', () => {
  test('two processes fold to what the suite covered, and the lcov parts are gone after', async () => {
    const root = await fixtureApp();
    try {
      const commands: (readonly string[])[] = [];
      const workerIds: (string | undefined)[] = [];
      const runner: Runner = (command, options) => {
        commands.push(command);
        workerIds.push(options.env?.['ULTIMATE_TEST_WORKER']);
        return exec(command, options);
      };
      const run = await runCovered({
        root,
        runner,
        files: ['apps/web/site/loads.test.ts', 'apps/web/app/math.test.ts'],
        workers: 2,
        sliceFiles: 1,
        widthReason: '2 workers (test)',
      });
      expect(run.ok).toBe(true);
      expect(run.findings).toEqual([]);
      expect(run.tests).toEqual({ ran: 2, skipped: 0 });
      expect(run.workers).toBe(2);
      expect(run.widthReason).toBe('2 workers (test)');
      expect(commands).toHaveLength(2);
      expect([...workerIds].sort()).toEqual(['0', '1']);
      const math = run.coverage['apps/web/app/math.ts'];
      if (math === undefined) expect.unreachable('math.ts was loaded by both processes');
      // The line the calling process ran is covered; the comment the loading process listed as
      // unrun is not a line at all; the function nothing called is uncovered.
      expect(math.hit).toContain(3);
      expect(math.miss).not.toContain(2);
      expect(math.miss).toContain(5);
      expect(math.funcsHit).toBe(1);
      expect(math.funcsFound).toBe(2);
      // Only the app's own tree: no test file's own record is dropped here, but nothing outside
      // `apps/` and `packages/` is kept.
      expect(Object.keys(run.coverage).every((file) => /^(apps|packages)\//.test(file))).toBe(true);
      expect(existsSync(join(root, COVERAGE_DIR, `unit-${String(process.pid)}`))).toBe(false);

      const measure = await measureCoverage(root, run.coverage, undefined);
      const unloaded = measure.losses.find((loss) => loss.file === 'apps/web/app/unloaded.ts');
      expect(unloaded).toEqual({
        file: 'apps/web/app/unloaded.ts',
        uncovered: 1,
        lines: 1,
        unloaded: true,
      });
      expect(measure.files).toBe(2);
      expect(measure.lines).toBeLessThan(100);
      expect(measure.funcsFound).toBe(3);
      expect(measure.funcsHit).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a red slice is X_TEST_FAILED with its output, and the parts are still removed', async () => {
    const root = await fixtureApp();
    try {
      await Bun.write(
        join(root, 'apps/web/app/red.test.ts'),
        "import { expect, test } from 'bun:test';\ntest('red', () => {\n  expect(1).toBe(2);\n});\n",
      );
      const run = await runCovered({
        root,
        runner: exec,
        files: ['apps/web/app/red.test.ts', 'apps/web/site/loads.test.ts'],
        workers: 1,
        sliceFiles: 1,
        isolate: true,
      });
      expect(run.ok).toBe(false);
      expect(run.findings.map((finding) => finding.code)).toEqual(['X_TEST_FAILED']);
      expect(run.findings[0]?.fix).toContain('x test unit');
      expect(run.findings[0]?.fix).toContain('--isolate');
      expect(run.output).toContain('red');
      expect(run.output).not.toContain('loads.test.ts');
      expect(run.tests).toEqual({ ran: 2, skipped: 0 });
      expect(existsSync(join(root, COVERAGE_DIR, `unit-${String(process.pid)}`))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the machine lease narrows the pool, marks the children, and is given back', async () => {
    const root = await fixtureApp();
    try {
      let released = 0;
      const held: (string | undefined)[] = [];
      const runner: Runner = (command, options) => {
        held.push(options.env?.['ULTIMATE_TEST_SLOT_HELD']);
        return exec(command, options);
      };
      const run = await runCovered({
        root,
        runner,
        files: ['apps/web/site/loads.test.ts', 'apps/web/app/math.test.ts'],
        workers: 2,
        sliceFiles: 1,
        lease: async (want) => {
          expect(want).toBe(2);
          return {
            count: 1,
            release: () => {
              released += 1;
            },
          };
        },
      });
      expect(run.ok).toBe(true);
      expect(run.workers).toBe(1);
      expect(held).toEqual(['1', '1']);
      expect(released).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
