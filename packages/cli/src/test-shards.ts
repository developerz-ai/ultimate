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
import { testPasses } from './test-passes';
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
  /**
   * Everything after a bare `--`, handed to `bun test` verbatim and BEFORE the file list, which is
   * where bun reads its flags. `ParsedArgs.passthrough` had no reader anywhere until 2026-09, so
   * `x test unit -- --coverage --bail` parsed both flags, carried them through the command and
   * dropped them on the floor — a run that reported exactly what a coverage run reports, with no
   * coverage measured. `CommandSpec.passthrough` is what keeps the other commands from doing the
   * same in silence: they refuse the `--` instead.
   */
  readonly passthrough?: readonly string[];
}): readonly string[] {
  const files = [...input.files].sort();
  const extra = input.passthrough ?? [];
  return input.shard === undefined
    ? ['bun', 'test', `--parallel=${String(input.workers)}`, ...extra, ...files]
    : [
        'bun',
        'test',
        '--isolate',
        `--shard=${String(input.shard + 1)}/${String(input.workers)}`,
        ...extra,
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
  /** What the caller put after `--`. It reaches `bun test`, so a rerun without it runs differently. */
  readonly passthrough?: readonly string[];
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
    // Last, and after a `--` of its own, because that is where the caller typed it and where the
    // parser will find it again. Quoted for `shell-quote.ts`'s reason: a reproduce line is pasted.
    ...(options.passthrough === undefined || options.passthrough.length === 0
      ? []
      : ['--', ...options.passthrough.map(quoteArg)]),
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
  /** Everything after the caller's `--`, forwarded to every pass and printed in the reproduce. */
  readonly passthrough?: readonly string[];
}

/**
 * The reproduction's inputs for ONE pass: `workers` is that pass's real width, not the ask, and
 * `type` is the pass's own when the split gave it one — `x test live --workers 1` reruns exactly
 * the files that failed, where the whole invocation's flags would rerun the corpus around them.
 */
const planOf = (
  options: RunShardsOptions,
  pass: { readonly workers: number; readonly type?: TestType },
): ReproduceOptions => ({
  workers: pass.workers,
  ...(options.filter === undefined ? {} : { filter: options.filter }),
  ...(pass.type === undefined ? {} : { type: pass.type }),
  ...(options.sample === undefined ? {} : { sample: options.sample.kept }),
  ...(options.affected === undefined ? {} : { affected: options.affected }),
  ...(options.only === undefined ? {} : { shard: options.only }),
  ...(options.passthrough === undefined || options.passthrough.length === 0
    ? {}
    : { passthrough: options.passthrough }),
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
 * ONE `bun test` PER PASS, and one pass unless the selection mixes serial files with the rest —
 * `test-passes.ts` decides that, and this spends it. Bun owns the pool inside a pass and hands
 * each free worker the next file, so nothing here decides which file runs where; see this file's
 * header for what that measured.
 *
 * Sequential, never `Promise.all`: the whole point of a serial pass is that nothing runs beside
 * it. And every pass runs even after one fails — the caller asked for a suite, and a report that
 * stops at the first red step hides the rest of the answer.
 *
 * `ULTIMATE_TEST_WORKER` is still set for a `--worker` rerun and only then: that run is one
 * process, so naming its database is this file's to do. A `--parallel` run has N of them and Bun
 * numbers each with `BUN_TEST_WORKER_ID`, which `@ultimat3/testing`'s `workerId` already reads.
 */
export async function runShards(options: RunShardsOptions): Promise<CommandResult> {
  const only = options.only;
  const passes = testPasses({
    files: options.files,
    workers: options.workers,
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(only === undefined ? {} : { shard: only }),
  });
  const started = performance.now();
  const steps: StepResult[] = [];
  const spent: JsonValue[] = [];
  let ok = true;
  let exitCode = 0;
  for (const pass of passes) {
    const files = pass.files.map((file) => file.path);
    const result = await options.runner(
      testArgs({
        files,
        workers: pass.workers,
        ...(only === undefined ? {} : { shard: only }),
        ...(options.passthrough === undefined ? {} : { passthrough: options.passthrough }),
      }),
      {
        cwd: options.root,
        ...(only === undefined ? {} : { env: { ULTIMATE_TEST_WORKER: String(only) } }),
      },
    );
    const plan = planOf(options, pass);
    const label =
      only === undefined ? `${pass.workers} worker(s)` : `shard ${only} of ${pass.workers}`;
    steps.push({
      name: `${pass.type === undefined ? label : `${pass.type} · ${label}`} · ${files.length} files`,
      ok: result.ok,
      durationMs: result.durationMs,
      // `output.ts` documents this field as absent for a NON-test step, so omitting it here made
      // `renderJson` describe the test step as one — recoverable only by parsing `name`.
      workers: pass.workers,
      findings: result.ok ? [] : [failureOf(result.code, files.length, plan)],
      output: execOutput(result),
    });
    spent.push({
      ...(pass.type === undefined ? {} : { type: pass.type }),
      files: files.length,
      workers: pass.workers,
      ok: result.ok,
      exitCode: result.code,
      reproduce: reproduceFor(plan),
    });
    ok = ok && result.ok;
    if (exitCode === 0) exitCode = result.code;
  }
  const durationMs = Math.round(performance.now() - started);
  const fileCount = options.files.length;
  // The width the RUN reached, which is the widest pass: a mixed selection whose serial half ran
  // one at a time did not become a one-worker run, and reporting it as one would misname the
  // reproduce a reader is handed.
  const workers = Math.max(1, ...passes.map((pass) => pass.workers));
  const plan = planOf(options, {
    workers,
    ...(options.type === undefined ? {} : { type: options.type }),
  });
  const type = options.type;
  const typeParam = type === undefined ? {} : { type };
  const sample = options.sample;
  const data: JsonValue = {
    ...typeParam,
    workers,
    files: fileCount,
    durationMs,
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(sample === undefined ? {} : { sample: { kept: sample.kept, total: sample.total } }),
    ...(only === undefined ? {} : { shard: only }),
    // Only when the split made more than one, so a single-pass run's JSON is byte-identical to
    // what it has always been — and a mixed one can never be read as if it were a single run.
    ...(spent.length > 1 ? { passes: spent } : {}),
    ok,
    exitCode,
    reproduce: reproduceFor(plan),
  };
  return {
    ok,
    command: 'test',
    summary: ok
      ? msg(type === undefined ? 'cli.test.pass' : 'cli.test.type.pass', {
          ...typeParam,
          files: fileCount,
          workers,
          ms: durationMs,
        })
      : msg(type === undefined ? 'cli.test.fail' : 'cli.test.type.fail', {
          ...typeParam,
          failed: steps.filter((step) => !step.ok).length,
          workers,
        }),
    steps,
    ...(sample === undefined
      ? {}
      : { lines: [msg('cli.test.sampled', { ...sample, type: type ?? 'all' })] }),
    data,
    exitCode: ok ? 0 : 1,
  };
}
