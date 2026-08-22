// `x jobs ls|show|retry|cancel|drain` — introspect and recover the job queue, bound to
// `@ultimat3/jobs`'s
// own introspection so the CLI, `/_x` and MCP report identically. This file is CLI wiring only:
// the driver-injected logic is `jobs-report.ts`, the `--json` shapes `jobs-json.ts`, the table
// `jobs-table.ts`, and getting hold of the queue at all is `jobs-driver.ts` — shared with `x db`.

import type { JobDriver } from '@ultimat3/jobs';
import { cancelJob, createMemoryDriver, createNatsDriver, createRedisDriver } from '@ultimat3/jobs';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, JobUnknownError, MissingPositionalError } from './errors';
import { drainJobs } from './jobs-drain';
import { withJobDriver } from './jobs-driver';
import {
  backfillToJson,
  deadLetterToJson,
  depthToJson,
  drainFailureToJson,
  drainSkipToJson,
  jobRecordToJson,
  jobTraceToJson,
} from './jobs-json';
import { listJobs, retryJob, showJob } from './jobs-report';
import { renderJobTable } from './jobs-table';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool, flagString } from './parse';

export const JOBS_SUBCOMMANDS = ['ls', 'show', 'retry', 'cancel', 'drain'] as const;

const DRAIN_TARGETS = ['memory', 'redis', 'nats'] as const;

function requireIdPositional(ctx: CommandContext, sub: string): string {
  const id = ctx.args.positionals[0];
  if (id === undefined) {
    // `--id on "x jobs"` is a flag `x jobs` does not declare; the id is a positional and says so.
    throw new MissingPositionalError({
      command: `jobs ${sub}`,
      positional: 'id',
      example: 'x jobs ls --json',
    });
  }
  return id;
}

function requireEnvUrl(env: CommandContext['env'], name: string, target: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new BadFlagError({
      flag: 'to',
      command: 'jobs',
      reason: `--to ${target} needs ${name} set in the environment`,
    });
  }
  return value;
}

/**
 * `redis`/`nats` are honest `X_NOT_IMPLEMENTED` stubs in `@ultimat3/jobs` — building one here is
 * fine even though every `enqueue` on it will fail; `drainJobs` reports that per record.
 * Exported so a test can drive the `--to`/env-var validation without a driver or a boot.
 */
export function buildDrainTarget(to: string | undefined, env: CommandContext['env']): JobDriver {
  if (to === undefined || !(DRAIN_TARGETS as readonly string[]).includes(to)) {
    throw new BadFlagError({
      flag: 'to',
      command: 'jobs',
      reason: `expects one of: ${DRAIN_TARGETS.join(', ')}`,
    });
  }
  if (to === 'memory') return createMemoryDriver();
  if (to === 'redis') return createRedisDriver({ url: requireEnvUrl(env, 'REDIS_URL', 'redis') });
  return createNatsDriver({ servers: [requireEnvUrl(env, 'NATS_URL', 'nats')] });
}

async function runLs(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const result = await listJobs(driver, {
    queue: flagString(ctx.args, 'queue'),
    state: flagString(ctx.args, 'state'),
    name: flagString(ctx.args, 'name'),
    limit: flagString(ctx.args, 'limit'),
  });
  const lines = [`  ${msg('cli.jobs.listed', { count: result.rows.length })}`];
  if (result.rows.length > 0) {
    lines.push(...renderJobTable(result.rows).map((line) => `  ${line}`));
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
    },
  };
}

async function runShow(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const trace = await showJob(driver, requireIdPositional(ctx, 'show'));
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
  const id = requireIdPositional(ctx, 'retry');
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
  const id = requireIdPositional(ctx, 'cancel');
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

/**
 * A skipped candidate is not an error — a job whose `runAt` has not arrived is unclaimable by
 * design — so it carries no `X_*` finding. It still fails the command: `x jobs drain` is run to
 * empty a driver, and a partial move that exited 0 would read as "the queue is clear".
 */
async function runDrain(driver: JobDriver, ctx: CommandContext): Promise<CommandResult> {
  const target = buildDrainTarget(flagString(ctx.args, 'to'), ctx.env);
  const dryRun = flagBool(ctx.args, 'dry-run');
  const outcome = await drainJobs(driver, target, dryRun);
  const findings = outcome.failures.map((failure) => failure.finding);
  const lines: string[] = [];
  if (outcome.skipped.length > 0) {
    const count = outcome.skipped.length;
    lines.push(`  ${msg('cli.jobs.skipped', { count, from: outcome.from })}`);
    for (const skip of outcome.skipped) {
      lines.push(`    ${skip.id}  ${skip.name}  (${skip.queue})  ${skip.state}  ${skip.reason}`);
    }
  }
  const partial = outcome.skipped.length > 0;
  return {
    ok: findings.length === 0 && !partial,
    command: 'jobs',
    summary: msg(partial ? 'cli.jobs.drainedPartial' : 'cli.jobs.drained', {
      count: dryRun ? outcome.candidates.length : outcome.moved.length,
      from: outcome.from,
      to: outcome.to,
      skipped: outcome.skipped.length,
    }),
    lines,
    findings,
    data: {
      from: outcome.from,
      to: outcome.to,
      dryRun: outcome.dryRun,
      candidates: outcome.candidates.map(jobRecordToJson),
      moved: outcome.moved.map(jobRecordToJson),
      skipped: outcome.skipped.map(drainSkipToJson),
      failures: outcome.failures.map(drainFailureToJson),
    },
  };
}

export const jobsCommand: CliCommand = {
  spec: {
    name: 'jobs',
    summary: 'list, show, retry, cancel and drain the job queue',
    usage:
      'x jobs [ls|show <id>|retry <id>|cancel <id>|drain --to <driver>] [--queue q] [--state s] [--limit n] [--from-step name] [--reason text] [--to driver] [--dry-run] [--json]',
    requiresApp: true,
    subcommands: JOBS_SUBCOMMANDS,
    // The bare `x jobs` lists; it never retries, cancels or drains anything.
    defaultSubcommand: 'ls',
    flags: [
      { name: 'queue', type: 'string', summary: 'filter by queue name' },
      { name: 'state', type: 'string', summary: 'filter by job state' },
      { name: 'limit', type: 'string', summary: 'max rows to return' },
      { name: 'name', type: 'string', summary: 'filter by job name' },
      // Each of these is read by ONE subcommand — `retryJob`, `cancelJob`, `runDrain` — and says
      // so in its own summary. The scope is what makes the parser refuse it anywhere else instead
      // of accepting it and ignoring it: `x db gen --dry-run` parsed and wrote the migration.
      {
        name: 'from-step',
        type: 'string',
        summary: 'retry: drop this step so it re-executes',
        subcommands: ['retry'],
      },
      {
        name: 'reason',
        type: 'string',
        summary: 'cancel: why, recorded on the job',
        subcommands: ['cancel'],
      },
      {
        name: 'to',
        type: 'string',
        summary: 'drain: target driver — memory, redis, nats',
        subcommands: ['drain'],
      },
      {
        name: 'dry-run',
        type: 'boolean',
        summary: 'drain: report the plan, move nothing',
        subcommands: ['drain'],
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('jobs', ctx.cwd).dir;
    const sub = ctx.args.subcommand ?? 'ls';
    return withJobDriver(root, ctx, (driver) => {
      if (sub === 'show') return runShow(driver, ctx);
      if (sub === 'retry') return runRetry(driver, ctx);
      if (sub === 'cancel') return runCancel(driver, ctx);
      if (sub === 'drain') return runDrain(driver, ctx);
      return runLs(driver, ctx);
    });
  },
};

export type { DrainFailure, DrainOutcome, DrainSkip } from './jobs-drain';
export { drainJobs } from './jobs-drain';
export type { JobsListFilter, JobsListResult } from './jobs-report';
export { listJobs, retryJob, showJob } from './jobs-report';
