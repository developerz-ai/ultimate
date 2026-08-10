// `x jobs ls|show|retry|drain` — introspect and recover the job queue, bound to `@ultimat3/jobs`'s
// own introspection so the CLI, `/_x` and MCP report identically. This file is CLI wiring only:
// the driver-injected logic is `jobs-report.ts`, the `--json` shapes `jobs-json.ts`, the table
// `jobs-table.ts`.

import type { JobDriver } from '@ultimat3/jobs';
import { createMemoryDriver, createNatsDriver, createRedisDriver, jobDriver } from '@ultimat3/jobs';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { startQueue } from './dev-queue';
import { resolveServices } from './dev-services';
import { BadFlagError } from './errors';
import { drainJobs } from './jobs-drain';
import {
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

export const JOBS_SUBCOMMANDS = ['ls', 'show', 'retry', 'drain'] as const;

const DRAIN_TARGETS = ['memory', 'redis', 'nats'] as const;

/**
 * `x jobs` needs the app's real driver. Reuse an already-running one first — inside `x dev` or
 * `x mcp serve`, `jobDriver()` is already set and booting a second queue on top of it would talk
 * to the wrong database. Otherwise boot just the db + jobs half (`startQueue`, not the full
 * `startServices`: this command touches no transport, storage or mail) and always release it, or
 * a CLI that exits holding the PGlite lock breaks the next command run against this app.
 */
async function withDriver(
  root: string,
  ctx: CommandContext,
  fn: (driver: JobDriver) => Promise<CommandResult>,
): Promise<CommandResult> {
  const ambient = jobDriver();
  if (ambient !== undefined) return fn(ambient);
  const services = resolveServices(root, ctx.env);
  const queue = await startQueue(services);
  try {
    return await fn(queue.jobs);
  } finally {
    await queue.stop();
  }
}

function requireIdPositional(ctx: CommandContext, sub: string): string {
  const id = ctx.args.positionals[0];
  if (id === undefined) {
    throw new BadFlagError({
      flag: 'id',
      command: 'jobs',
      reason: `"x jobs ${sub}" needs a job id: x jobs ${sub} <id>`,
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
    summary: 'list, show, retry and drain the job queue',
    usage:
      'x jobs [ls|show <id>|retry <id>|drain --to <driver>] [--queue q] [--state s] [--limit n] [--from-step name] [--to driver] [--dry-run] [--json]',
    requiresApp: true,
    subcommands: JOBS_SUBCOMMANDS,
    flags: [
      { name: 'queue', type: 'string', summary: 'filter by queue name' },
      { name: 'state', type: 'string', summary: 'filter by job state' },
      { name: 'limit', type: 'string', summary: 'max rows to return' },
      { name: 'name', type: 'string', summary: 'filter by job name' },
      { name: 'from-step', type: 'string', summary: 'retry: drop this step so it re-executes' },
      { name: 'to', type: 'string', summary: 'drain target driver: memory, redis, nats' },
      { name: 'dry-run', type: 'boolean', summary: 'drain: report the plan, move nothing' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('jobs', ctx.cwd).dir;
    const sub = ctx.args.subcommand ?? 'ls';
    return withDriver(root, ctx, (driver) => {
      if (sub === 'show') return runShow(driver, ctx);
      if (sub === 'retry') return runRetry(driver, ctx);
      if (sub === 'drain') return runDrain(driver, ctx);
      return runLs(driver, ctx);
    });
  },
};

export type { DrainFailure, DrainOutcome, DrainSkip } from './jobs-drain';
export { drainJobs } from './jobs-drain';
export type { JobsListFilter, JobsListResult } from './jobs-report';
export { listJobs, retryJob, showJob } from './jobs-report';
