// What makes ci.yml's unit parts finish inside their 5-minute target: every core of the runner
// working (the test memory budget), and Bun handed last run's per-file durations so each batch
// starts its slowest files first (the timings cache, merged across parts by `verify`). Split from
// `ci-workflow-shape.test.ts`; the merge step is RUN here, as the plan step is there.

import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path'; // why: Bun ships no path API.
import { TEST_TIMINGS_FILE } from '../packages/cli/src/test-shards';
import { MEMORY_BUDGET_ENV, workerPlan } from '../packages/cli/src/test-workers';
import { expr, type Job, jobOf, readWorkflow, type Step, text } from './lib/ci-workflow-read';

const ci = await readWorkflow('ci.yml');
const gate = jobOf(ci, 'gate');
const verify = jobOf(ci, 'verify');
const GIB = 1024 ** 3;
/** `ubuntu-latest` for a public repository, As of 2026-11: four cores, 16 GB. */
const RUNNER = { cpus: 4, totalBytes: 16 * GIB } as const;

const indexOf = (job: Job, match: (step: Step) => boolean): number =>
  (job.steps ?? []).findIndex(match);
const gateRun = indexOf(gate, (step) => text(step.run).includes('scripts/verify.ts --only'));

describe('unit · ci.yml · a unit part works every core of its runner', () => {
  const env = { [MEMORY_BUDGET_ENV]: text(gate.env?.[MEMORY_BUDGET_ENV]) };

  test('the gate plans one worker per core — the laptop default leaves a core idle', () => {
    // The default is a quarter of the machine, for a laptop shared with an editor and other gates
    // (`test-workers.ts`); a runner is the gate's alone. 3 workers on 4 cores was unit-2's 276 s
    // (run 43562415694); `packages (1/3)` already runs `cli` at 4 isolated workers on this runner.
    expect(workerPlan(RUNNER.cpus, RUNNER.totalBytes, {}).workers).toBe(3);
    expect(workerPlan(RUNNER.cpus, RUNNER.totalBytes, env).workers).toBe(RUNNER.cpus);
  });

  test('the budget stays under half the runner: room for Postgres and the coordinator', () => {
    expect(workerPlan(RUNNER.cpus, RUNNER.totalBytes, env).budgetBytes).toBeLessThanOrEqual(
      RUNNER.totalBytes / 2,
    );
  });
});

describe('unit · ci.yml · a unit part starts each batch with its slowest files', () => {
  const restoreAt = indexOf(
    gate,
    (step) =>
      text(step.uses).startsWith('actions/cache/restore@') &&
      step.with?.['path'] === TEST_TIMINGS_FILE,
  );
  const restore = gate.steps?.[restoreAt];
  const uploadAt = indexOf(
    gate,
    (step) =>
      text(step.uses).startsWith('actions/upload-artifact@') &&
      step.with?.['path'] === TEST_TIMINGS_FILE,
  );
  const upload = gate.steps?.[uploadAt];
  const saveAt = indexOf(verify, (step) => text(step.uses).startsWith('actions/cache/save@'));
  const save = verify.steps?.[saveAt];
  const mergeAt = indexOf(verify, (step) => text(step.run).includes(TEST_TIMINGS_FILE));
  const merge = verify.steps?.[mergeAt];

  test('a unit part restores the newest merged timings before it runs, and only a unit part', () => {
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(restoreAt).toBeLessThan(gateRun);
    expect(restore?.if).toBe("contains(matrix.only, 'unit')");
    expect(restore?.with?.['restore-keys']).toBe('test-timings-');
  });

  test('every unit part hands its timings on, red or green: they measure the clock, not the verdict', () => {
    expect(uploadAt).toBeGreaterThan(gateRun);
    expect(upload?.if).toBe(expr("!cancelled() && contains(matrix.only, 'unit')"));
    expect(upload?.with?.['name']).toBe(
      `test-timings-${expr('matrix.part')}-attempt-${expr('github.run_attempt')}`,
    );
    // A part that died before its first batch wrote nothing; the cache simply stays as it was.
    expect(upload?.with?.['if-no-files-found']).toBe('ignore');
    // `.x/` is a dot-directory: without this the upload finds nothing, silently, every run.
    expect(upload?.with?.['include-hidden-files']).toBe(true);
  });

  test('verify merges every part`s timings into one file and saves it under the restored prefix', () => {
    expect(mergeAt).toBeGreaterThanOrEqual(0);
    expect(saveAt).toBeGreaterThan(mergeAt);
    expect(save?.with?.['path']).toBe(TEST_TIMINGS_FILE);
    expect(text(save?.with?.['key']).startsWith(text(restore?.with?.['restore-keys']))).toBe(true);
    expect(save?.with?.['key']).toBe(restore?.with?.['key']);
    // Only a merge that wrote a file saves one: an empty entry would shadow the last good one.
    expect(merge?.id).toBe('timings');
    expect(save?.if).toBe("steps.timings.outputs.merged == 'true'");
  });

  /** The merge step, run in bash in a scratch `$RUNNER_TEMP` holding `parts`' timings files. */
  const runMerge = async (
    parts: Readonly<Record<string, Readonly<Record<string, number>> | null>>,
  ): Promise<{ readonly code: number; readonly merged: unknown; readonly output: string }> => {
    const temp = await mkdtemp(join(tmpdir(), 'ci-timings-merge-'));
    try {
      for (const [part, files] of Object.entries(parts)) {
        const dir = join(temp, 'timings', part);
        await mkdir(dir, { recursive: true });
        if (files !== null) {
          await Bun.write(join(dir, 'test-timings.json'), JSON.stringify({ version: 1, files }));
        }
      }
      const output = join(temp, 'output');
      const child = Bun.spawn(['bash', '-c', text(merge?.run)], {
        cwd: temp,
        env: { ...Bun.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const code = await child.exited;
      const file = Bun.file(join(temp, TEST_TIMINGS_FILE));
      return {
        code,
        merged: (await file.exists()) ? await file.json() : undefined,
        output: (await Bun.file(output).exists()) ? await Bun.file(output).text() : '',
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  };

  test('the merge, RUN: every part`s files in one document, a part with no file adds nothing', async () => {
    const run = await runMerge({
      'test-timings-unit-1-attempt-1': { 'a.test.ts': 10, 'shared.test.ts': 1 },
      'test-timings-unit-2-attempt-1': { 'b.test.ts': 20 },
      'test-timings-unit-3-attempt-1': null,
    });
    expect(run.code).toBe(0);
    expect(run.merged).toEqual({
      version: 1,
      files: { 'a.test.ts': 10, 'shared.test.ts': 1, 'b.test.ts': 20 },
    });
    expect(run.output).toContain('merged=true');
  });

  test('the merge, RUN, with no part`s timings: green, no file, nothing to save', async () => {
    const run = await runMerge({});
    expect(run.code).toBe(0);
    expect(run.merged).toBeUndefined();
    expect(run.output).not.toContain('merged=true');
  });
});
