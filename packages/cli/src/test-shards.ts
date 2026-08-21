// Spending the selected test files: the LPT plan that balances them across worker processes, the
// argv each child gets, and the command that reproduces one shard exactly. Split out of
// cmd-test.ts because a printed reproduction is only true if it carries every input to the split —
// that rule is this file's, and argv parsing is that one's.

import type { AffectedSelection } from './affected';
import { docsFor } from './error-codes';
import type { Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue, StepResult } from './output';
import { quoteArg } from './shell-quote';
import type { TestFile } from './test-select';
import { bySizeThenPath } from './test-select';
import type { TestType } from './verify-tests';

export interface Shard {
  readonly index: number;
  readonly files: readonly string[];
  readonly bytes: number;
}

/**
 * Largest-first greedy bin packing (LPT). Deterministic — the total order is (size desc, path asc),
 * so the filesystem's scan order never reaches the assignment and a CI failure on worker 3 is the
 * same worker 3 locally. Balanced — every file lands in the currently emptiest bin, which bounds a
 * bin at average + largest file; round-robin or hashing can pile every slow file onto one worker.
 * The inner scan is O(files × workers), and workers is a core count, so a heap would only add
 * allocation.
 */
export function planShards(files: readonly TestFile[], workers: number): readonly Shard[] {
  const count = Math.max(1, Math.min(Math.trunc(workers), files.length));
  const loads = new Array<number>(count).fill(0);
  const buckets: string[][] = Array.from({ length: count }, () => []);
  for (const file of [...files].sort(bySizeThenPath)) {
    let target = 0;
    for (let i = 1; i < count; i += 1) if ((loads[i] ?? 0) < (loads[target] ?? 0)) target = i;
    buckets[target]?.push(file.path);
    loads[target] = (loads[target] ?? 0) + file.bytes;
  }
  return buckets.map((paths, index) => ({
    index,
    files: [...paths].sort(),
    bytes: loads[index] ?? 0,
  }));
}

/**
 * Explicit file list, so the child never re-globs and can never pick up another shard's files.
 *
 * `--isolate` is what makes an arbitrary partition safe, and it is not optional. Half a dozen
 * registries in this framework are process-global by design — the permission set, the roles, the
 * entity/action/query tables, the error-code titles, the fixture bag — and a serial `bun test`
 * only passes because glob order happens to put every declaring file before every file that reads
 * what it left behind. Re-partition the same files and that accident is gone: measured on this
 * repo, an 8-way split turned 0 failures into 36, all of them `X_PERMISSION_UNKNOWN` in
 * `@ultimat3/query` because the `packages/cli` file that had been declaring `feed:read` for it
 * landed in another shard. A fresh module registry per FILE removes the channel entirely, so the
 * split can be any split. The database is isolated per WORKER, not per file — one cloned template
 * per process, which is `ULTIMATE_TEST_WORKER` below.
 */
export const SHARD_COMMAND_PREFIX = ['bun', 'test', '--isolate'] as const;

export const shardArgs = (shard: Shard): readonly string[] => [
  ...SHARD_COMMAND_PREFIX,
  ...shard.files,
];

export interface ReproduceOptions {
  /** The *effective* worker count: `planShards` clamps to the file count, and the split follows. */
  readonly workers: number;
  readonly filter?: string;
  readonly type?: TestType;
  /** Files `--sample` kept, so the rerun samples the same corpus instead of the whole type. */
  readonly sample?: number;
  /**
   * The `--affected` narrowing, when there was one. The fourth input to the split and the one most
   * easily forgotten: `--affected` decides which files exist to shard at all, so a rerun without it
   * re-splits the WHOLE corpus and its shard 2 is a different shard 2.
   */
  readonly affected?: AffectedSelection;
}

/**
 * Every input to the split, printed back. The type, `--filter` and `--affected` decide which files
 * exist to shard, `--sample` decides how many of them survive, `--workers` decides the bins — drop
 * any one and the command still runs, over a different file set, which reproduces nothing.
 */
export function reproduceFor(shard: Shard, options: ReproduceOptions): string {
  return [
    'x test',
    ...(options.type === undefined ? [] : [quoteArg(options.type)]),
    ...(options.filter === undefined ? [] : ['--filter', quoteArg(options.filter)]),
    ...(options.sample === undefined ? [] : ['--sample', String(options.sample)]),
    // `--base` is emitted always rather than only when non-default: the default is `main`, and a
    // rerun days later against a moved `main` is a different diff wearing the same flag.
    ...(options.affected === undefined
      ? []
      : ['--affected', '--base', quoteArg(options.affected.base)]),
    ...(options.affected?.dirty === true ? ['--dirty'] : []),
    '--workers',
    String(options.workers),
    '--worker',
    String(shard.index),
  ].join(' ');
}

export interface RunShardsOptions {
  readonly root: string;
  readonly runner: Runner;
  readonly files: readonly TestFile[];
  readonly workers: number;
  /** Run exactly one shard of the same split, not a one-worker run of everything. */
  readonly only?: number;
  readonly filter?: string;
  readonly type?: TestType;
  /**
   * Set when `--sample` narrowed `files`: `kept` is what survived, `total` what discovery found.
   * `kept` is carried rather than counted from the shards that ran, because `--worker N` runs one
   * shard of the sample and would otherwise report that shard's size as the corpus.
   */
  readonly sample?: { readonly kept: number; readonly total: number };
  /** Passed straight to `reproduceFor`: see `ReproduceOptions.affected`. */
  readonly affected?: AffectedSelection;
}

/** The reproduction's inputs, resolved once: `workers` is the split's real width, not the ask. */
const planOf = (options: RunShardsOptions, workers: number): ReproduceOptions => ({
  workers,
  ...(options.filter === undefined ? {} : { filter: options.filter }),
  ...(options.type === undefined ? {} : { type: options.type }),
  ...(options.sample === undefined ? {} : { sample: options.sample.kept }),
  ...(options.affected === undefined ? {} : { affected: options.affected }),
});

const failureOf = (shard: Shard, code: number, plan: ReproduceOptions): Finding => ({
  code: 'X_TEST_SHARD_FAILED',
  cause: `shard ${shard.index} of ${plan.workers} exited ${code} (${shard.files.length} file(s))`,
  fix: reproduceFor(shard, plan),
  docs: docsFor('X_TEST_SHARD_FAILED'),
});

export async function runShards(options: RunShardsOptions): Promise<CommandResult> {
  const shards = planShards(options.files, options.workers);
  const only = options.only;
  const chosen = only === undefined ? shards : shards.filter((shard) => shard.index === only);
  const started = performance.now();
  // All shards at once: wall-clock is the whole point, and each one owns a separate database.
  const runs = await Promise.all(
    chosen.map(async (shard) => ({
      shard,
      result: await options.runner(shardArgs(shard), {
        cwd: options.root,
        env: { ULTIMATE_TEST_WORKER: String(shard.index) },
      }),
    })),
  );
  const durationMs = Math.round(performance.now() - started);
  const plan = planOf(options, shards.length);
  const steps: readonly StepResult[] = runs.map(({ shard, result }) => ({
    name: `shard ${shard.index} · ${shard.files.length} files`,
    ok: result.ok,
    durationMs: result.durationMs,
    findings: result.ok ? [] : [failureOf(shard, result.code, plan)],
    output: execOutput(result),
  }));
  const failed = runs.filter((run) => !run.result.ok).map((run) => run.shard.index);
  const fileCount = chosen.reduce((total, shard) => total + shard.files.length, 0);
  const type = options.type;
  const typeParam = type === undefined ? {} : { type };
  const sample = options.sample;
  const data: JsonValue = {
    ...typeParam,
    workers: shards.length,
    files: fileCount,
    durationMs,
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(sample === undefined ? {} : { sample: { kept: sample.kept, total: sample.total } }),
    shards: runs.map(({ shard, result }) => ({
      index: shard.index,
      files: shard.files.length,
      bytes: shard.bytes,
      ok: result.ok,
      exitCode: result.code,
      durationMs: result.durationMs,
      reproduce: reproduceFor(shard, plan),
    })),
    failed,
  };
  return {
    ok: failed.length === 0,
    command: 'test',
    summary:
      failed.length === 0
        ? msg(type === undefined ? 'cli.test.pass' : 'cli.test.type.pass', {
            ...typeParam,
            files: fileCount,
            workers: chosen.length,
            ms: durationMs,
          })
        : msg(type === undefined ? 'cli.test.fail' : 'cli.test.type.fail', {
            ...typeParam,
            failed: failed.length,
            workers: chosen.length,
          }),
    steps,
    ...(sample === undefined
      ? {}
      : { lines: [msg('cli.test.sampled', { ...sample, type: type ?? 'all' })] }),
    data,
    exitCode: failed.length === 0 ? 0 : 1,
  };
}
