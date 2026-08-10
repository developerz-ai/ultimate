// `x test` — the missing half of the framework's test isolation. @ultimat3/testing already gives
// every worker its own template-cloned database, keyed on ULTIMATE_TEST_WORKER; nothing ever set
// that variable or spawned a second process, so the whole suite ran serially against one database.
// This shards the files test-select.ts discovers and hands each process its worker index — scoped
// to one of the six test types when the caller names one.

import { cpus } from 'node:os';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, docsFor, NoTestFilesError } from './errors';
import type { Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue, StepResult } from './output';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import type { TestFile } from './test-select';
import {
  bySizeThenPath,
  discoverTests,
  missingSelection,
  readSample,
  readType,
  sampleFiles,
} from './test-select';
import type { TestType } from './verify-tests';
import { TEST_TYPES } from './verify-tests';

export type { TestFile } from './test-select';
export { discoverTests } from './test-select';

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

/** Explicit file list, so the child never re-globs and can never pick up another shard's files. */
export const shardArgs = (shard: Shard): readonly string[] => ['bun', 'test', ...shard.files];

/**
 * `--workers` is part of the reproduction: a different worker count is a different split. So are
 * the type and the substring filter — either one changes which files exist to shard in the first
 * place, so the printed command has to carry both to actually reselect this shard's files.
 */
export function reproduceFor(
  shard: Shard,
  workers: number,
  filter: string | undefined,
  type: TestType | undefined,
): string {
  const parts = [
    'x test',
    ...(type === undefined ? [] : [type]),
    ...(filter === undefined ? [] : ['--filter', filter]),
    `--workers ${workers}`,
    `--worker ${shard.index}`,
  ];
  return parts.join(' ');
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
  /** Set when `--sample` narrowed `files`; `total` is the count before sampling. */
  readonly sample?: { readonly total: number };
}

const failureOf = (shard: Shard, code: number, opts: RunShardsOptions, of: number): Finding => ({
  code: 'X_TEST_SHARD_FAILED',
  cause: `shard ${shard.index} of ${of} exited ${code} (${shard.files.length} file(s))`,
  fix: reproduceFor(shard, of, opts.filter, opts.type),
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
  const steps: readonly StepResult[] = runs.map(({ shard, result }) => ({
    name: `shard ${shard.index} · ${shard.files.length} files`,
    ok: result.ok,
    durationMs: result.durationMs,
    findings: result.ok ? [] : [failureOf(shard, result.code, options, shards.length)],
    output: execOutput(result),
  }));
  const failed = runs.filter((run) => !run.result.ok).map((run) => run.shard.index);
  const fileCount = chosen.reduce((total, shard) => total + shard.files.length, 0);
  const type = options.type;
  const typeParam = type === undefined ? {} : { type };
  const data: JsonValue = {
    ...typeParam,
    workers: shards.length,
    files: fileCount,
    durationMs,
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.sample === undefined
      ? {}
      : { sample: { kept: fileCount, total: options.sample.total } }),
    shards: runs.map(({ shard, result }) => ({
      index: shard.index,
      files: shard.files.length,
      bytes: shard.bytes,
      ok: result.ok,
      exitCode: result.code,
      durationMs: result.durationMs,
      reproduce: reproduceFor(shard, shards.length, options.filter, type),
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
    ...(options.sample === undefined
      ? {}
      : {
          lines: [
            msg('cli.test.sampled', {
              kept: fileCount,
              total: options.sample.total,
              type: type ?? 'all',
            }),
          ],
        }),
    data,
    exitCode: failed.length === 0 ? 0 : 1,
  };
}

/** navigator first: it is the runtime's own answer, and it respects a container's CPU limit. */
export function availableCpus(): number {
  const hinted = typeof navigator === 'undefined' ? Number.NaN : navigator.hardwareConcurrency;
  return Math.max(1, Number.isFinite(hinted) && hinted > 0 ? Math.trunc(hinted) : cpus().length);
}

function readIndex(args: ParsedArgs, name: string, min: number): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new BadFlagError({
      flag: name,
      command: 'test',
      reason: `expects an integer >= ${min}, got "${raw}"`,
    });
  }
  return value;
}

export const testCommand: CliCommand = {
  spec: {
    name: 'test',
    summary:
      'run one test type — or the whole suite — across N processes, one isolated database per worker',
    usage: `x test [${TEST_TYPES.join('|')}] [--filter text] [--sample N] [--workers N] [--worker I] [--json]`,
    flags: [
      { name: 'workers', type: 'string', summary: 'process count (default: available CPUs)' },
      {
        name: 'worker',
        type: 'string',
        summary: 'rerun only shard I of the same split — reproduces a CI worker failure locally',
      },
      { name: 'filter', type: 'string', summary: 'only files whose path contains this substring' },
      {
        name: 'sample',
        type: 'string',
        summary:
          'run at most N files of the selected type — a fast signal for the eval loop, never a gate',
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const type = readType(ctx.args.positionals[0]);
    const filter = flagString(ctx.args, 'filter');
    const sample = readSample(ctx.args);
    const discovered = await discoverTests(ctx.cwd, filter, type);
    if (discovered.length === 0) {
      throw new NoTestFilesError({ root: ctx.cwd, ...missingSelection(type, filter) });
    }
    const files = sample === undefined ? discovered : sampleFiles(discovered, sample);
    const requested = readIndex(ctx.args, 'workers', 1) ?? availableCpus();
    const workers = Math.max(1, Math.min(requested, files.length));
    const only = readIndex(ctx.args, 'worker', 0);
    if (only !== undefined && only >= workers) {
      throw new BadFlagError({
        flag: 'worker',
        command: 'test',
        reason: `shard ${only} does not exist in a ${workers}-worker split (0..${workers - 1})`,
      });
    }
    return runShards({
      root: ctx.cwd,
      runner: ctx.runner,
      files,
      workers,
      ...(only === undefined ? {} : { only }),
      ...(filter === undefined ? {} : { filter }),
      ...(type === undefined ? {} : { type }),
      ...(sample === undefined ? {} : { sample: { total: discovered.length } }),
    });
  },
};
