// `x jobs list|show|retry|cancel|delete|promote|pause|resume` — introspect and recover the job queue,
// bound to `@ultimat3/jobs`'s own introspection so the CLI, `/_x` and MCP report identically;
// `drain` is planned (`cmd-planned.ts`): Postgres is the one durable driver. CLI wiring only:
// the driver-injected logic is `jobs-report.ts`, the `--json` shapes `jobs-json.ts`, the table
// `jobs-table.ts`, and getting hold of the queue at all is `jobs-driver.ts` — shared with `x db`.

import { renderFixShellArg } from '@ultimat3/core';
import type { JobDriver } from '@ultimat3/jobs';
import {
  cancelJob,
  MAX_JOB_PAGE,
  pauseQueue,
  promoteJob,
  removeJob,
  resumeQueue,
} from '@ultimat3/jobs';
import { loadApp } from './app-load';
import { requireAppRoot } from './app-root';
import { jobsSpec } from './cmd-jobs-spec';
import { plannedSubcommand } from './cmd-planned';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, JobUnknownError, MissingPositionalError } from './errors';
import { withJobDriver } from './jobs-driver';
import {
  backfillToJson,
  deadLetterToJson,
  depthToJson,
  jobRecordToJson,
  jobTraceToJson,
  pausedToJson,
  workerToJson,
} from './jobs-json';
import { listJobs, retryJob, showJob } from './jobs-report';
import { renderJobTable } from './jobs-table';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagString } from './parse';

export { JOBS_SUBCOMMANDS } from './cmd-jobs-spec';

/**
 * A uuid in any spelling Postgres' `uuid` input accepts: canonical, upper-case, unhyphenated,
 * braced. Every driver mints its ids with core's `uuid()`, and `x_jobs.id` is a `uuid` column.
 */
const JOB_ID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;

/**
 * The id, parsed at the door — admin's `readableId` rule: an id no driver could hold is a job that
 * does not exist, answered before a statement is sent. `x jobs show nosuch` reached Postgres and
 * came back a raw `X_DB_STATEMENT_FAILED [22P02]` whose fix was a psql session.
 */
function requireIdPositional(ctx: CommandContext, sub: string, driver: JobDriver): string {
  const id = ctx.args.positionals[0];
  if (id === undefined) {
    // `--id on "x jobs"` is a flag `x jobs` does not declare; the id is a positional and says so.
    throw new MissingPositionalError({
      command: `jobs ${sub}`,
      positional: 'id',
      example: 'x jobs list --json',
    });
  }
  if (!JOB_ID.test(id)) throw new JobUnknownError({ id, driver: driver.name });
  return id;
}

function requireQueuePositional(ctx: CommandContext, sub: string): string {
  const queue = ctx.args.positionals[0];
  if (queue === undefined) {
    throw new MissingPositionalError({
      command: `jobs ${sub}`,
      positional: 'queue',
      example: `x jobs ${sub} default --json`,
    });
  }
  return queue;
}

/**
 * A page past the queue's own bound is refused HERE, as a flag error with the command that walks
 * instead — `list()` would refuse it too, in the vocabulary of a caller holding a driver.
 */
function refuseOversizedPage(limit: string | undefined): void {
  if (limit === undefined || !/^\d+$/.test(limit) || Number(limit) <= MAX_JOB_PAGE) return;
  throw new BadFlagError({
    flag: 'limit',
    command: 'jobs',
    reason: `one page holds at most ${MAX_JOB_PAGE} jobs`,
    // The bound is the queue's own constant, screened like any value spliced into a command.
    fix: `x jobs list --limit ${renderFixShellArg(String(MAX_JOB_PAGE), '200')} --json   # then pass its data.nextCursor as --after while data.hasMore is true`,
  });
}

async function runList(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const limit = flagString(ctx.args, 'limit');
  refuseOversizedPage(limit);
  const result = await listJobs(driver, {
    queue: flagString(ctx.args, 'queue'),
    state: flagString(ctx.args, 'state'),
    name: flagString(ctx.args, 'name'),
    limit,
    after: flagString(ctx.args, 'after'),
  });
  // `nextCursor` exists exactly when a row past this page does (`listJobs` asks the queue), so a
  // full last page prints no "next page" a caller would follow to an empty one.
  const next = result.nextCursor;
  const [paused, workers] = await Promise.all([
    driver.introspect?.pausedQueues() ?? [],
    driver.introspect?.workers() ?? [],
  ]);
  const lines = [`  ${msg('cli.jobs.listed', { count: result.rows.length })}`];
  if (result.rows.length > 0) {
    lines.push(...renderJobTable(result.rows).map((line) => `  ${line}`));
  }
  if (next !== null) lines.push(`  ${msg('cli.jobs.nextPage', { cursor: next })}`);
  if (paused.length > 0) {
    lines.push(
      `  ${msg('cli.jobs.pausedQueues', { queues: paused.map((q) => q.name).join(', ') })}`,
    );
  }
  if (result.deadLetters.length > 0) {
    lines.push(`  ${msg('cli.jobs.deadLetters', { count: result.deadLetters.length })}`);
    for (const entry of result.deadLetters) {
      const why = entry.lastError ?? msg('cli.jobs.noError');
      lines.push(
        `    ${entry.id}  ${entry.name}  (${entry.queue})  ${why}  — ${entry.retryCommand}`,
      );
    }
  }
  // Same shape as the dead-letter section above, and here for the same reason: a sweep in flight
  // is a fact the depth counts cannot show. Name, rows so far and cursor, because "how far has it
  // got" is the whole question — the finished passes are `x db backfill --list`'s answer.
  if (result.backfills.length > 0) {
    lines.push(`  ${msg('cli.jobs.backfills', { count: result.backfills.length })}`);
    for (const pass of result.backfills) {
      const cursor = pass.cursor ?? msg('cli.jobs.backfillNoCursor');
      const progress = msg('cli.jobs.backfillRow', { name: pass.name, rows: pass.rows, cursor });
      lines.push(`    ${pass.runId}  ${progress}`);
    }
  }
  return {
    ok: true,
    command: 'jobs',
    summary: msg('cli.jobs.depth', {
      ready: result.depth.totals.ready,
      running: result.depth.totals.running,
      delayed: result.depth.totals.delayed,
      dead: result.depth.totals.dead,
      queues: result.depth.queues.length,
    }),
    lines,
    data: {
      depth: depthToJson(result.depth),
      rows: result.rows.map(jobRecordToJson),
      deadLetters: result.deadLetters.map(deadLetterToJson),
      backfills: result.backfills.map(backfillToJson),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      pausedQueues: paused.map(pausedToJson),
      workers: workers.map(workerToJson),
    },
  };
}

async function runShow(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const trace = await showJob(driver, requireIdPositional(ctx, 'show', driver));
  return {
    ok: true,
    command: 'jobs',
    summary: msg('cli.jobs.shown', {
      id: trace.id,
      state: trace.state,
      attempt: trace.attempt,
      attempts: trace.maxAttempts,
    }),
    data: jobTraceToJson(trace),
  };
}

async function runRetry(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const id = requireIdPositional(ctx, 'retry', driver);
  const trace = await retryJob(driver, id, flagString(ctx.args, 'from-step'));
  return {
    ok: true,
    command: 'jobs',
    summary: msg('cli.jobs.retried', { id: trace.id, state: trace.state }),
    data: jobTraceToJson(trace),
  };
}

/**
 * There is no silent-success path here, and that is the whole reason this subcommand can exist as
 * four lines: `cancelJob` throws `X_JOB_NOT_CANCELLABLE` for a job that has already finished and
 * for a driver with no `cancel` at all, so an exit code of 0 means the job is genuinely stopped.
 * The trace is rendered by the same projection `show` and `retry` use — one shape for one job.
 */
async function runCancel(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const id = requireIdPositional(ctx, 'cancel', driver);
  const trace = await cancelJob(driver, id, flagString(ctx.args, 'reason'));
  // `cancelJob` re-reads the job after cancelling, so `undefined` would mean the row vanished
  // between the two — reported as the same refusal rather than rendered as a success with no job.
  if (trace === undefined) throw new JobUnknownError({ id, driver: driver.name });
  return {
    ok: true,
    command: 'jobs',
    summary: msg('cli.jobs.cancelled', { id: trace.id, state: trace.state }),
    data: jobTraceToJson(trace),
  };
}

/** Exit 0 means the row is gone. An id nobody queued is `X_JOB_UNKNOWN`; a running one refuses. */
async function runDelete(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const id = requireIdPositional(ctx, 'delete', driver);
  const removed = await removeJob(driver, id);
  if (removed === undefined) throw new JobUnknownError({ id, driver: driver.name });
  return {
    ok: true,
    command: 'jobs',
    summary: msg('cli.jobs.removed', { id: removed.id, state: removed.state }),
    data: jobRecordToJson(removed),
  };
}

async function runPromote(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const promoted = await promoteJob(driver, requireIdPositional(ctx, 'promote', driver));
  return {
    ok: true,
    command: 'jobs',
    summary: msg('cli.jobs.promoted', { id: promoted.id }),
    data: jobRecordToJson(promoted),
  };
}

/**
 * Both verbs answer the list as the queue NOW holds it, read back after the write: the pause is a
 * row every worker's next claim reads, so "paused" here is paused fleet-wide within one poll.
 */
async function runPause(
  driver: JobDriver,
  ctx: CommandContext,
  sub: 'pause' | 'resume',
): Promise<CommandResult> {
  const queue = requireQueuePositional(ctx, sub);
  const paused = await (sub === 'pause' ? pauseQueue(driver, queue) : resumeQueue(driver, queue));
  return {
    ok: true,
    command: 'jobs',
    summary: msg(sub === 'pause' ? 'cli.jobs.paused' : 'cli.jobs.resumed', { queue }),
    data: { queue, paused: sub === 'pause', pausedQueues: paused.map(pausedToJson) },
  };
}

/** The subcommands that answer a `JobTrace`. `list`, `delete`, `promote` and the rest read rows only. */
const TRACE_SUBCOMMANDS: ReadonlySet<string> = new Set(['show', 'retry', 'cancel']);

export const jobsCommand: CliCommand = {
  spec: jobsSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('jobs', ctx.cwd).dir;
    const sub = ctx.args.subcommand ?? 'list';
    // BEFORE `withJobDriver`, which boots the source queue: the answer needs no server, so a box
    // whose database is down gets it rather than the boot failure of a queue never to be used —
    // and nothing is leased. 24.x's `--to`/`--dry-run` are deleted, so the parser refuses them
    // (`X_CLI_BAD_FLAG`); only a bare `x jobs drain` reaches this answer.
    if (sub === 'drain') throw plannedSubcommand('jobs', 'drain');
    // A TRACE is the queue row projected through the job's own declaration — its concurrency key,
    // its retry schedule — and a declaration exists in this process only once the app is loaded.
    // Unloaded, `show` answered `concurrencyKey: null` and `retryDelaysMs: []` for every job of
    // every app. The findings are deliberately dropped: a trace is read to debug a stuck queue,
    // so an app that half-loads degrades those two fields and still answers.
    if (TRACE_SUBCOMMANDS.has(sub)) await loadApp(root);
    return withJobDriver(root, ctx, (driver) => {
      if (sub === 'show') return runShow(driver, ctx);
      if (sub === 'retry') return runRetry(driver, ctx);
      if (sub === 'cancel') return runCancel(driver, ctx);
      if (sub === 'delete') return runDelete(driver, ctx);
      if (sub === 'promote') return runPromote(driver, ctx);
      if (sub === 'pause' || sub === 'resume') return runPause(driver, ctx, sub);
      return runList(driver, ctx);
    });
  },
};

export type { JobsListFilter, JobsListResult } from './jobs-report';
export { listJobs, retryJob, showJob } from './jobs-report';
