// Running one test type as one gate step. Split from verify-tests.ts because that file owns which
// files belong to a type and this one owns what happens to them once selected — a wrong file list
// is never a race, and a race is never a selection bug.

import type { Runner } from './exec';
import type { Finding } from './output';
import { runBatches, testBatches } from './test-batches';
import { countsOf } from './test-counts';
import { testEnvOverrides } from './test-dotenv';
import type { TestFile } from './test-select';
import { failureOf, ISOLATED_TEST_ENV, testArgs } from './test-shards';
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
  /** This process's own environment. Optional and defaulted to `Bun.env` — see `VerifyContext.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** A fresh global per file — `x.verify.json` `"isolate": true` or `--isolate`. Default off. */
  readonly isolate?: boolean;
  /** Why the width is what it is — printed on the step line. */
  readonly widthReason?: string;
  /** The machine-pool lease (`test-slots.ts`), for a default-width run. */
  readonly lease?: (want: number) => Promise<{ readonly count: number; release(): void }>;
}

/**
 * `bun test --parallel=N` per batch (`test-batches.ts`), not N processes this file spawns and
 * packs itself.
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
  const envOverrides = {
    ...testEnvOverrides(options.root, options.env ?? Bun.env),
    ...(options.isolate === true ? { [ISOLATED_TEST_ENV]: '1' } : {}),
  };
  // Batched exactly as `x test` batches the same selection at the same width, so the gate's
  // `fix:` line — `x test <type> --workers N` — reruns the very processes that failed.
  const batches = testBatches(files, workers);
  const result = await runBatches({
    runner: options.runner,
    batches,
    workers,
    ...(options.lease === undefined || workers === 1 ? {} : { lease: options.lease }),
    argsFor: (batch, width) =>
      testArgs({ files: batch, workers: width, isolate: options.isolate === true }),
    options: {
      cwd: options.root,
      ...(Object.keys(envOverrides).length === 0 ? {} : { env: envOverrides }),
    },
  });
  // `failureOf` is `x test`'s own, imported rather than restated: the two paths report the SAME
  // failed `bun test`, so a second literal here is two `cause:` strings and two `fix:` lines free
  // to drift — and the one that drifts is the gate's, which is the one an agent reads first.
  const findings: readonly Finding[] = result.ok
    ? []
    : [
        failureOf(result.code, files.length, {
          workers,
          type: options.type,
          ...(options.isolate === true ? { isolate: true } : {}),
        }),
      ];
  // The width the run REACHED: a batch the machine pool narrowed ran narrower than planned, and a
  // step line that printed the plan would name a width that never ran.
  const reached = Math.max(1, ...result.widths);
  const narrowed = reached < workers;
  return {
    ok: findings.length === 0,
    findings,
    workers: reached,
    ...(options.widthReason === undefined
      ? {}
      : {
          widthReason: narrowed
            ? `${String(reached)} of ${options.widthReason} — machine slots held by another run`
            : options.widthReason,
        }),
    // Per batch: each process printed its own summary, and one parse of the joined text would
    // read only the last one.
    tests: countsOf(result.results),
    // Only on failure: a green run's summary is already the step table's, and the reader of a red
    // gate needs the assertion diff.
    ...(result.ok ? {} : { output: result.output }),
  };
}
