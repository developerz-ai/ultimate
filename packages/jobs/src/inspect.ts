// Introspection for `/_x`, the CLI and MCP. Every function returns a plain JSON-serialisable
// object so `x jobs ... --json` and the MCP tool share one shape — an agent debugging a stuck
// queue reads exactly what the dashboard renders.

import type { BackfillProgress } from './backfill-inspect';
import { backfillForRun } from './backfill-inspect';
import type { JobDriver, JobFilter, JobRecord, QueueStats } from './driver';
import { CancelUnsupportedError, JobNotCancellableError, JobsNotImplementedError } from './errors';
import { registeredJobs } from './job';
import { retrySchedule } from './retry';
import type { Scheduler } from './scheduler';
import type { StepRecord } from './steps';
import { registeredTasks } from './task';

export interface QueueDepthReport {
  readonly driver: string;
  readonly queues: readonly QueueStats[];
  readonly totals: {
    readonly ready: number;
    readonly delayed: number;
    readonly running: number;
    readonly suspended: number;
    readonly dead: number;
  };
  /** Oldest claimable job across all queues, in ms. The autoscaling signal. */
  readonly oldestReadyMs: number;
}

export async function inspectQueues(driver: JobDriver): Promise<QueueDepthReport> {
  const queues = [...(await driver.stats())];
  const totals = queues.reduce(
    (acc, queue) => ({
      ready: acc.ready + queue.ready,
      delayed: acc.delayed + queue.delayed,
      running: acc.running + queue.running,
      suspended: acc.suspended + queue.suspended,
      dead: acc.dead + queue.dead,
    }),
    { ready: 0, delayed: 0, running: 0, suspended: 0, dead: 0 },
  );
  return {
    driver: driver.name,
    queues,
    totals,
    oldestReadyMs: queues.reduce((max, queue) => Math.max(max, queue.oldestReadyMs), 0),
  };
}

export interface StepTrace {
  readonly name: string;
  readonly status: StepRecord['status'];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly wakeAt: string | null;
  readonly durationMs: number | null;
  readonly attempts: number;
  readonly error: string | null;
}

export interface JobTrace {
  readonly id: string;
  readonly name: string;
  readonly queue: string;
  readonly state: JobRecord['state'];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly runAt: string;
  readonly lastError: string | null;
  readonly tenantId: string | null;
  /** W3C `traceparent` of the request that queued it — paste it into the trace viewer. */
  readonly traceparent: string | null;
  /** Actor id of whoever asked. Audit only: the body ran with system authority. */
  readonly enqueuedBy: string | null;
  readonly steps: readonly StepTrace[];
  /** Remaining retry delays in ms, jitter excluded. */
  readonly retryDelaysMs: readonly number[];
  /**
   * The `x_backfills` row this run wrote, when the job is a `backfill()`. `null` for every other
   * job and for a driver with no ledger — a step trace says which batch is next, and this says how
   * many rows the pass has actually put behind it.
   */
  readonly backfill: BackfillProgress | null;
}

const iso = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString();

function requireIntrospection(driver: JobDriver): NonNullable<JobDriver['introspect']> {
  if (driver.introspect === undefined) {
    throw new JobsNotImplementedError({
      feature: `introspection for the "${driver.name}" jobs driver`,
      fix: "set jobs: { driver: 'postgres' } in app.config.ts, then: x jobs ls --json",
    });
  }
  return driver.introspect;
}

function toStepTrace(record: StepRecord): StepTrace {
  return {
    name: record.name,
    status: record.status,
    startedAt: new Date(record.startedAt).toISOString(),
    completedAt: iso(record.completedAt),
    wakeAt: iso(record.wakeAt),
    durationMs: record.completedAt === undefined ? null : record.completedAt - record.startedAt,
    attempts: record.attempts,
    error: record.error ?? null,
  };
}

export async function inspectJob(driver: JobDriver, jobId: string): Promise<JobTrace | undefined> {
  const record = await requireIntrospection(driver).job(jobId);
  if (record === undefined) return undefined;
  const steps = await driver.steps.list(record.runId);
  const handle = registeredJobs().find((candidate) => candidate.name === record.name);
  const backfill = await backfillForRun(driver, record.runId);
  return {
    id: record.id,
    name: record.name,
    queue: record.queue,
    state: record.state,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    idempotencyKey: record.idempotencyKey,
    runId: record.runId,
    runAt: new Date(record.runAt).toISOString(),
    lastError: record.lastError ?? null,
    tenantId: record.tenantId ?? null,
    traceparent: record.traceparent ?? null,
    enqueuedBy: record.enqueuedBy ?? null,
    steps: steps.map(toStepTrace),
    retryDelaysMs: handle === undefined ? [] : [...retrySchedule(handle.retry)],
    backfill: backfill ?? null,
  };
}

export function inspectJobList(
  driver: JobDriver,
  filter?: JobFilter,
): Promise<readonly JobRecord[]> {
  return requireIntrospection(driver).list(filter);
}

export interface DeadLetterEntry {
  readonly id: string;
  readonly name: string;
  readonly queue: string;
  readonly attempt: number;
  readonly lastError: string | null;
  readonly failedAt: string;
  readonly retryCommand: string;
}

export async function inspectDeadLetters(
  driver: JobDriver,
  limit = 100,
): Promise<readonly DeadLetterEntry[]> {
  const rows = await requireIntrospection(driver).deadLetters(limit);
  return rows.map((record) => ({
    id: record.id,
    name: record.name,
    queue: record.queue,
    attempt: record.attempt,
    lastError: record.lastError ?? null,
    failedAt: new Date(record.updatedAt).toISOString(),
    retryCommand: `x jobs retry ${record.id}`,
  }));
}

/**
 * Re-queue a job, optionally dropping one step's persisted result so it re-executes while
 * everything before it replays from storage. This is why steps are stored, not just logged.
 */
export async function retryFromStep(
  driver: JobDriver,
  jobId: string,
  stepName?: string,
): Promise<JobTrace | undefined> {
  await requireIntrospection(driver).requeue(
    jobId,
    stepName === undefined ? undefined : { fromStep: stepName },
  );
  return inspectJob(driver, jobId);
}

/**
 * Stop a job from outside — the surface `x jobs cancel <id>` binds to. The hard half was already
 * built: `execute.ts` cancels the attempt and `steps.ts` fences every write behind that signal.
 * What was missing was anything that could TRIGGER it, so a runaway backfill against production
 * left two options: scale the worker to zero (stopping every job) or `UPDATE x_jobs` by hand,
 * which the worker's next ack overwrote because `SQL_ACK` had no state guard.
 *
 * Refuses loudly rather than answering "nothing happened": an operator cancelling a 40M-row sweep
 * has to know whether they stopped it or missed it.
 */
export async function cancelJob(
  driver: JobDriver,
  jobId: string,
  reason?: string,
): Promise<JobTrace | undefined> {
  const introspect = requireIntrospection(driver);
  if (introspect.cancel === undefined) throw new CancelUnsupportedError({ driver: driver.name });
  const record = await introspect.cancel(jobId, reason);
  if (record === undefined) {
    const current = await introspect.job(jobId);
    throw new JobNotCancellableError({ jobId, state: current?.state ?? 'missing' });
  }
  return inspectJob(driver, jobId);
}

export interface JobsManifest {
  readonly jobs: readonly {
    readonly name: string;
    readonly queue: string;
    readonly attempts: number;
    readonly backoff: string;
    readonly concurrency: number | null;
    readonly timeoutMs: number | null;
    readonly retryDelaysMs: readonly number[];
  }[];
  readonly tasks: readonly {
    readonly name: string;
    readonly cron: string;
    readonly tz: string;
    readonly catchUp: string;
    readonly nextRun: string | null;
    readonly enqueues: readonly string[];
  }[];
}

/** Feeds `x.manifest.json` and the MCP `jobs.list` tool. Generated facts, never prose. */
export function inspectManifest(scheduler?: Scheduler): JobsManifest {
  return {
    jobs: registeredJobs().map((handle) => ({
      name: handle.name,
      queue: handle.queue,
      attempts: handle.retry.attempts,
      backoff: handle.retry.backoff ?? 'exponential',
      concurrency: handle.concurrency ?? null,
      timeoutMs: handle.timeoutMs ?? null,
      retryDelaysMs: [...retrySchedule(handle.retry)],
    })),
    tasks: registeredTasks().map((handle) => ({
      name: handle.name,
      cron: handle.cron,
      tz: handle.tz,
      catchUp: handle.catchUp,
      nextRun: scheduler === undefined ? null : scheduler.nextRunFor(handle).toISOString(),
      enqueues: handle.entries().map(([job]) => job.name),
    })),
  };
}
