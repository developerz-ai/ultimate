// Which test files the `flaky` CI job reruns — the ones a pull request changed, of the suites the
// unit parts run, as anchored paths, over fixed lists — and the job in ci.yml that reruns them.

import { describe, expect, test } from 'bun:test';
import { bareTestPaths } from '../bun-test-paths';
import { jobOf, readWorkflow, text } from '../ci-workflow-read';
import { capRerun, RERUN_CAP, RERUN_EACH, rerunPaths } from './rerun-changed';

const present = (): boolean => true;

describe('unit · ci · the changed test files the flaky job reruns', () => {
  test('keeps changed unit, contract and job test files, anchored, sorted and once each', () => {
    expect(
      rerunPaths(
        [
          'scripts/verify.test.ts',
          'packages/core/src/errors.test.ts',
          'packages/ui/src/button.test.tsx',
          'packages/db/src/ledger.contract.test.ts',
          'packages/jobs/src/retry.job.test.ts',
          'packages/core/src/errors.test.ts',
        ],
        present,
      ),
    ).toEqual([
      './packages/core/src/errors.test.ts',
      './packages/db/src/ledger.contract.test.ts',
      './packages/jobs/src/retry.job.test.ts',
      './packages/ui/src/button.test.tsx',
      './scripts/verify.test.ts',
    ]);
  });

  test('drops sources, the suites that need more than one database, and nested apps', () => {
    expect(
      rerunPaths(
        [
          'packages/core/src/errors.ts',
          'packages/db/src/replica.live.test.ts',
          'packages/testing/e2e/cdp-browser.e2e.test.ts',
          'packages/cli/e2e/upgrade.test.ts',
          'packages/ai/src/answer.eval.test.ts',
          'examples/dummy/apps/web/island-bytes.test.ts',
          'dummy/docs-site/guards/island-mount-clears.test.ts',
          'packages/core/dist/errors.test.ts',
          'wiki/Testing.md',
        ],
        present,
      ),
    ).toEqual([]);
  });

  // A pull request that deletes a test lists it in its diff; `bun test` handed a missing path is
  // red for a reason no rerun found.
  test('drops a changed file the checkout no longer has', () => {
    const exists = (path: string): boolean => path !== 'scripts/gone.test.ts';
    expect(rerunPaths(['scripts/gone.test.ts', 'scripts/kept.test.ts'], exists)).toEqual([
      './scripts/kept.test.ts',
    ]);
  });

  test('reads a Windows separator and a CRLF line as the same path', () => {
    expect(rerunPaths(['scripts\\lib\\args.test.ts\r'], present)).toEqual([
      './scripts/lib/args.test.ts',
    ]);
  });

  test('an empty diff reruns nothing', () => {
    expect(rerunPaths([], present)).toEqual([]);
  });

  test('five runs: enough to see a one-in-three flake, cheap enough for a changed file', () => {
    expect(RERUN_EACH).toBe(5);
  });

  // A sweep that touches 300 test files would rerun 1,500 files inside a 10-minute job; the cap
  // keeps the first 40 of the sorted list and counts the rest, which the job prints as a notice.
  test('at most 40 files rerun, the first of the sorted list, and the rest are counted', () => {
    const many = Array.from(
      { length: 45 },
      (_, at) => `./scripts/t${String(at).padStart(2, '0')}.test.ts`,
    );
    expect(RERUN_CAP).toBe(40);
    expect(capRerun(many)).toEqual({ paths: many.slice(0, 40), skipped: 5 });
    expect(capRerun(many.slice(0, 40))).toEqual({ paths: many.slice(0, 40), skipped: 0 });
    expect(capRerun([])).toEqual({ paths: [], skipped: 0 });
  });
});

const ci = await readWorkflow('ci.yml');

describe('unit · ci.yml · the flaky job reruns a pull request`s changed test files', () => {
  const flaky = jobOf(ci, 'flaky');
  const steps = flaky.steps ?? [];
  const index = (needle: string): number =>
    steps.findIndex((step) => text(step.run).includes(needle));
  const rerun = steps[index('bun test --parallel --rerun-each')];

  test('a pull request only, on a free runner, waiting on nothing', () => {
    expect(flaky.if).toBe("github.event_name == 'pull_request'");
    expect(flaky['runs-on']).toBe('ubuntu-latest');
    expect(flaky.needs).toBeUndefined();
  });

  test('the files are the diff`s, chosen by rerun-changed.ts, and nothing else', () => {
    const diff = index('git diff --no-renames --name-only HEAD^1 HEAD');
    const select = index('scripts/lib/ci/rerun-changed.ts "$RUNNER_TEMP/changed.txt" --json');
    expect(diff).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(diff);
    expect(steps.indexOf(rerun ?? {})).toBeGreaterThan(select);
    expect(text(rerun?.run)).toContain(
      `bun test --parallel --rerun-each ${String(RERUN_EACH)} "\${paths[@]}"`,
    );
    expect(bareTestPaths(text(rerun?.run))).toEqual([]);
    // The files past the cap are named as a count, never dropped in silence.
    const choice = steps.find((step) => step.id === 'select');
    expect(text(choice?.run)).toContain('.data.skipped');
    expect(text(choice?.run)).toContain('::notice title=');
    const checkout = steps.find((step) => text(step.uses).startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(2);
  });

  // No test file changed: every step past the diff is skipped, the install included; none kept by
  // the selection, everything past it.
  test('skipped past the diff when no test file changed, and past the choice when none is kept', () => {
    const diff = steps.findIndex((step) => step.id === 'diff');
    const select = steps.findIndex((step) => step.id === 'select');
    expect(diff).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(diff + 1);
    for (const step of steps.slice(diff + 1, select + 1)) {
      expect(step.if).toBe("steps.diff.outputs.tests == 'true'");
    }
    expect(steps.slice(select + 1).length).toBeGreaterThan(0);
    for (const step of steps.slice(select + 1)) {
      expect(step.if).toBe("steps.select.outputs.any == 'true'");
    }
    expect(JSON.stringify(flaky)).not.toContain('secrets.');
  });
});
