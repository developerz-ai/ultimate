// Running one test type across N worker processes and reporting it as one gate step. Split from
// verify-tests.ts because that file owns which files belong to a type and this one owns what
// happens to them once selected — a wrong file list is never a race, and a race is never a
// selection bug.

import { docsFor } from './errors';
import type { Runner } from './exec';
import { execOutput } from './exec';
import type { Finding } from './output';
import type { TestFile } from './test-select';
import { planShards, reproduceFor, shardArgs } from './test-shards';
import type { StepOutcome } from './verify-step';
// Type-only, so nothing here evaluates verify-tests.ts and the two files cannot form a cycle.
import type { TestType } from './verify-tests';

export interface ParallelRunOptions {
  readonly root: string;
  readonly runner: Runner;
  readonly files: readonly TestFile[];
  /** The ask. `planShards` clamps it to the file count, and the report carries what it became. */
  readonly workers: number;
  /** Carried into the `fix:` so a failed shard reproduces as `x test <type> --workers N …`. */
  readonly type: TestType;
}

/**
 * The whole point is wall-clock, so every shard starts at once. Two things make that safe and
 * neither is optional: `shardArgs` gives each FILE its own module registry (`--isolate`), and
 * `ULTIMATE_TEST_WORKER` gives each PROCESS its own database — `@ultimat3/testing`'s
 * `acquireWorkerDatabase` reads exactly that variable first and clones the migrated template into
 * `…_w<index>`. Rails' numbered test databases, with Postgres doing the copy.
 */
export async function runParallel(options: ParallelRunOptions): Promise<StepOutcome> {
  const shards = planShards(options.files, options.workers);
  const runs = await Promise.all(
    shards.map(async (shard) => ({
      shard,
      result: await options.runner(shardArgs(shard), {
        cwd: options.root,
        env: { ULTIMATE_TEST_WORKER: String(shard.index) },
      }),
    })),
  );
  const findings: Finding[] = [];
  for (const { shard, result } of runs) {
    if (result.ok) continue;
    findings.push({
      code: 'X_TEST_SHARD_FAILED',
      cause: `${options.type} shard ${shard.index} of ${shards.length} exited ${result.code} (${shard.files.length} file(s))`,
      // The reproduction has to name every input to the split, or it reruns a different file set:
      // `reproduceFor` is the one place that rule lives, shared with `x test`.
      fix: reproduceFor(shard, { workers: shards.length, type: options.type }),
      docs: docsFor('X_TEST_SHARD_FAILED'),
    });
  }
  // Only the failing shards' output: a green 8-way split would otherwise print eight summaries,
  // and the reader of a red gate needs the assertion diff, not the seven runs that passed.
  const output = runs
    .filter((run) => !run.result.ok)
    .map((run) => `— shard ${run.shard.index}\n${execOutput(run.result)}`)
    .join('\n');
  return {
    ok: findings.length === 0,
    findings,
    workers: shards.length,
    ...(output === '' ? {} : { output }),
  };
}
