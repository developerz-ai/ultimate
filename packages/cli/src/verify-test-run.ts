// Running one test type as one gate step. Split from verify-tests.ts because that file owns which
// files belong to a type and this one owns what happens to them once selected — a wrong file list
// is never a race, and a race is never a selection bug.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Runner } from './exec';
import { execOutput } from './exec';
import type { Finding } from './output';
import { countsOf } from './test-counts';
import type { TestFile } from './test-select';
import { reproduceFor, testArgs } from './test-shards';
import type { StepOutcome } from './verify-step';
// Type-only, so nothing here evaluates verify-tests.ts and the two files cannot form a cycle.
import type { TestType } from './verify-tests';

export interface ParallelRunOptions {
  readonly root: string;
  readonly runner: Runner;
  readonly files: readonly TestFile[];
  /** The ask. Clamped to the file count, and the report carries what it became. */
  readonly workers: number;
  /** Carried into the `fix:` so a failure reproduces as `x test <type> --workers N`. */
  readonly type: TestType;
}

/**
 * ONE `bun test --parallel=N`, not N processes this file spawns and packs itself.
 *
 * Two things make an arbitrary partition safe here and neither is optional. `--parallel` implies
 * `--isolate`, so every FILE gets a fresh module registry — half a dozen registries in this
 * framework are process-global by design, and a serial run only passes because glob order happens
 * to put every declaring file before every file that reads what it left behind (measured: a bare
 * `bun test packages/` is 282 failures, the same corpus under `--isolate` is 0). And the database
 * is per WORKER: `@ultimat3/testing`'s `workerId` reads `BUN_TEST_WORKER_ID`, which Bun sets 1..N,
 * one per real process — so the numbered test databases keep working with nothing threaded here.
 *
 * `test-shards.ts`'s header carries what replacing the hand-written packer measured.
 */
export async function runParallel(options: ParallelRunOptions): Promise<StepOutcome> {
  const files = options.files.map((file) => file.path);
  const workers = Math.max(1, Math.min(Math.trunc(options.workers), files.length || 1));
  const result = await options.runner(testArgs({ files, workers }), { cwd: options.root });
  const findings: Finding[] = result.ok
    ? []
    : [
        {
          code: 'X_TEST_FAILED',
          cause: `${options.type} run exited ${result.code} across ${workers} worker(s) (${files.length} file(s))`,
          // The reproduction has to name every input to the selection or it reruns a different
          // file set: `reproduceFor` is the one place that rule lives, shared with `x test`.
          fix: reproduceFor({ workers, type: options.type }),
          docs: ERROR_DOCS_URL,
        } satisfies Finding,
      ];
  return {
    ok: findings.length === 0,
    findings,
    workers,
    tests: countsOf([result]),
    // Only on failure: a green run's summary is already the step table's, and the reader of a red
    // gate needs the assertion diff.
    ...(result.ok ? {} : { output: execOutput(result) }),
  };
}
