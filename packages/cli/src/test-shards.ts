// Spending the selected test files: the argv one `bun test` run gets, and the command that
// reproduces it exactly. Split out of cmd-test.ts because a printed reproduction is only true if
// it carries every input to the run — that rule is this file's, and argv parsing is that one's.
//
// ONE PROCESS, N WORKERS, `As of 2026-08-27`. This file used to pack the files into N bins itself
// (largest-first greedy over file SIZE) and `Promise.all` one `bun test` per bin. Bun 1.4 runs the
// pool itself — `--parallel=N`, which starts each file on the next free worker — so the packer is
// deleted rather than improved.
//
// THE PACKER WAS NOT COSTING TIME, AND THAT IS THE FINDING. Four interleaved runs of each form,
// one machine, the same 1296-file unit corpus, 8 workers:
//
//   8x `bun test --isolate`, hand-packed   58.2s  60.0s  65.0s  66.5s
//   1x `bun test --parallel=8`             54.5s  57.8s  61.7s  64.5s
//
// Within noise of each other, because both are already work-bound. `--update-timings` measures the
// corpus at 436.7s of file time, so eight workers cannot beat 54.6s however the files are dealt,
// and the slowest single file is 20.5s — far under that floor, so no one file sets it either. A
// greedy pack of 1296 small items lands near-optimal by accident, which is why bytes being a poor
// proxy for time never showed up as a wall. The change buys the DELETION, not the seconds: this
// file's packer and its `Shard` type gone, one process instead of eight, and Bun's own summary
// instead of eight merged ones (issue #342).
//
// `--timings` IS REFUSED FOR THE SAME REASON. Bun will start the slowest files first from a
// recorded timings file, but there is at most the ~5s between the measured 59.8s median and the
// 54.6s floor in it — against a committed JSON that goes stale on every test edit and that nothing
// in the gate would notice had gone stale.
//
// TWO THINGS THE OLD SPLIT OWNED AND BUN NOW OWNS. `--parallel` implies `--isolate`, so the
// per-FILE module registry that made an arbitrary partition safe at all is unchanged. And the
// per-WORKER database survives untouched: `@ultimat3/testing`'s `workerId` already read
// `BUN_TEST_WORKER_ID` as its second key, which is exactly what Bun sets, 1..N, one per real
// process (probed on 1.4.0). `ULTIMATE_TEST_WORKER` stays the first key and is what `--worker`
// still sets, so a single-shard rerun keeps naming its own database.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { AffectedSelection } from './affected';
import type { Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue, StepResult } from './output';
import { quoteArg } from './shell-quote';
import type { TestFile } from './test-select';
import type { TestType } from './verify-tests';

/**
 * The argv for one run. An explicit file list, never a re-glob: discovery already decided which
 * files belong to this type, and a child that globs again can pick up a file the selection removed.
 *
 * `--parallel=N` for the whole selection, `--shard=i+1/N` for one slice of it. The shard form is
 * `--worker`'s, and it carries `--isolate` in its own right — only `--parallel` implies it, and a
 * partition without a fresh module registry per file is the failure mode this whole design exists
 * to remove: measured on this repo, an 8-way split turned 0 failures into 36, every one
 * `X_PERMISSION_UNKNOWN` in `@ultimat3/query` because the `packages/cli` file that had been
 * declaring `feed:read` for it landed elsewhere. Half a dozen registries here are process-global by
 * design — the permission set, the roles, the entity/action/query tables, the error-code titles,
 * the fixture bag — and a serial `bun test` only passes because glob order happens to put every
 * declaring file before every file that reads what it left behind.
 *
 * Bun's shard partition is round-robin over the list it is given, so the sorted list this hands it
 * makes `--shard=2/8` the same 1/8 on CI and on a laptop (probed on 1.4.0).
 */
export function testArgs(input: {
  readonly files: readonly string[];
  readonly workers: number;
  /** 0-based, matching `--worker`. Absent runs the whole selection across `workers` processes. */
  readonly shard?: number;
}): readonly string[] {
  const files = [...input.files].sort();
  return input.shard === undefined
    ? ['bun', 'test', `--parallel=${String(input.workers)}`, ...files]
    : [
        'bun',
        'test',
        '--isolate',
        `--shard=${String(input.shard + 1)}/${String(input.workers)}`,
        ...files,
      ];
}

/**
 * The files an argv selects, flags stripped. `bun test` takes its file list positionally, so this
 * is the inverse of `testArgs` and the one thing a test asserting "what did the child get?" needs
 * — the flag COUNT is not fixed (`--parallel=N` is one token, a shard run carries two more), and a
 * test slicing a hardcoded prefix length reads a flag as a filename the day that changes.
 */
export const filesIn = (command: readonly string[]): readonly string[] =>
  command.slice(2).filter((arg) => !arg.startsWith('--'));

export interface ReproduceOptions {
  /** The *effective* worker count: the run clamps it to the file count, and the rerun follows. */
  readonly workers: number;
  readonly filter?: string;
  readonly type?: TestType;
  /** Files `--sample` kept, so the rerun samples the same corpus instead of the whole type. */
  readonly sample?: number;
  /**
   * The `--affected` narrowing, when there was one. The input most easily forgotten: `--affected`
   * decides which files exist to run at all, so a rerun without it selects the WHOLE corpus and
   * its shard 2 is a different shard 2.
   */
  readonly affected?: AffectedSelection;
  /** 0-based, when reproducing ONE shard. Absent reproduces the whole selection. */
  readonly shard?: number;
}

/**
 * Every input to the run, printed back. The type, `--filter` and `--affected` decide which files
 * exist, `--sample` decides how many of them survive, `--workers` decides the width — drop any one
 * and the command still runs, over a different file set, which reproduces nothing.
 */
export function reproduceFor(options: ReproduceOptions): string {
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
    ...(options.shard === undefined ? [] : ['--worker', String(options.shard)]),
  ].join(' ');
}

export interface RunShardsOptions {
  readonly root: string;
  readonly runner: Runner;
  readonly files: readonly TestFile[];
  readonly workers: number;
  /** Run exactly one shard of the same N-way split, not a one-worker run of everything. */
  readonly only?: number;
  readonly filter?: string;
  readonly type?: TestType;
  /**
   * Set when `--sample` narrowed `files`: `kept` is what survived, `total` what discovery found.
   * `kept` is carried rather than counted from what ran, because `--worker N` runs one shard of the
   * sample and would otherwise report that shard's size as the corpus.
   */
  readonly sample?: { readonly kept: number; readonly total: number };
  /** Passed straight to `reproduceFor`: see `ReproduceOptions.affected`. */
  readonly affected?: AffectedSelection;
}

/** The reproduction's inputs, resolved once: `workers` is the run's real width, not the ask. */
const planOf = (options: RunShardsOptions, workers: number): ReproduceOptions => ({
  workers,
  ...(options.filter === undefined ? {} : { filter: options.filter }),
  ...(options.type === undefined ? {} : { type: options.type }),
  ...(options.sample === undefined ? {} : { sample: options.sample.kept }),
  ...(options.affected === undefined ? {} : { affected: options.affected }),
  ...(options.only === undefined ? {} : { shard: options.only }),
});

/**
 * `X_TEST_SHARD_FAILED` for a `--worker` run and `X_TEST_FAILED` for a whole one, because the two
 * name different reruns: a shard is reproduced by naming it, and a full run by rerunning it. Both
 * codes already exist and both are already documented — a third would be a new name for a failed
 * `bun test`.
 */
export const failureOf = (code: number, files: number, plan: ReproduceOptions): Finding => ({
  code: plan.shard === undefined ? 'X_TEST_FAILED' : 'X_TEST_SHARD_FAILED',
  cause:
    plan.shard === undefined
      ? `${plan.type ?? 'test'} run exited ${code} across ${plan.workers} worker(s) (${files} file(s))`
      : `shard ${plan.shard} of ${plan.workers} exited ${code} (${files} file(s))`,
  fix: reproduceFor(plan),
  docs: ERROR_DOCS_URL,
});

/**
 * ONE `bun test`, not one per worker. Bun owns the pool and hands each free worker the next file,
 * so nothing here decides which file runs where — see this file's header for what that measured.
 *
 * `ULTIMATE_TEST_WORKER` is still set for a `--worker` rerun and only then: that run is one
 * process, so naming its database is this file's to do. A `--parallel` run has N of them and Bun
 * numbers each with `BUN_TEST_WORKER_ID`, which `@ultimat3/testing`'s `workerId` already reads.
 */
export async function runShards(options: RunShardsOptions): Promise<CommandResult> {
  const files = options.files.map((file) => file.path);
  const workers = Math.max(1, Math.min(Math.trunc(options.workers), files.length || 1));
  const only = options.only;
  const started = performance.now();
  const result = await options.runner(
    testArgs({ files, workers, ...(only === undefined ? {} : { shard: only }) }),
    {
      cwd: options.root,
      ...(only === undefined ? {} : { env: { ULTIMATE_TEST_WORKER: String(only) } }),
    },
  );
  const durationMs = Math.round(performance.now() - started);
  const plan = planOf({ ...options, workers }, workers);
  const type = options.type;
  const typeParam = type === undefined ? {} : { type };
  const sample = options.sample;
  const label = only === undefined ? `${workers} worker(s)` : `shard ${only} of ${workers}`;
  const steps: readonly StepResult[] = [
    {
      name: `${label} · ${files.length} files`,
      ok: result.ok,
      durationMs: result.durationMs,
      // `output.ts` documents this field as absent for a NON-test step, so omitting it here made
      // `renderJson` describe the test step as one — recoverable only by parsing `name`.
      workers,
      findings: result.ok ? [] : [failureOf(result.code, files.length, plan)],
      output: execOutput(result),
    },
  ];
  const data: JsonValue = {
    ...typeParam,
    workers,
    files: files.length,
    durationMs,
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(sample === undefined ? {} : { sample: { kept: sample.kept, total: sample.total } }),
    ...(only === undefined ? {} : { shard: only }),
    ok: result.ok,
    exitCode: result.code,
    reproduce: reproduceFor(plan),
  };
  return {
    ok: result.ok,
    command: 'test',
    summary: result.ok
      ? msg(type === undefined ? 'cli.test.pass' : 'cli.test.type.pass', {
          ...typeParam,
          files: files.length,
          workers,
          ms: durationMs,
        })
      : msg(type === undefined ? 'cli.test.fail' : 'cli.test.type.fail', {
          ...typeParam,
          failed: 1,
          workers,
        }),
    steps,
    ...(sample === undefined
      ? {}
      : { lines: [msg('cli.test.sampled', { ...sample, type: type ?? 'all' })] }),
    data,
    exitCode: result.ok ? 0 : 1,
  };
}
