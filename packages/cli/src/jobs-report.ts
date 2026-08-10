// Pure, driver-injected logic behind `x jobs`: list/show/retry/drain plus their JSON
// projections and the human table. No CLI parsing, no process I/O — a test drives every path
// with `createMemoryDriver()` alone; `cmd-jobs.ts` is the only file that wires flags to it.

import type {
  DeadLetterEntry,
  JobDriver,
  JobFilter,
  JobRecord,
  JobState,
  JobTrace,
  QueueDepthReport,
  QueueStats,
  StepTrace,
} from '@ultimat3/jobs';
import {
  inspectDeadLetters,
  inspectJob,
  inspectJobList,
  inspectQueues,
  retryFromStep,
} from '@ultimat3/jobs';
import { BadFlagError, JobUnknownError } from './errors';
import type { Finding, JsonValue } from './output';
import { findingFrom } from './output';

/** Mirrors `JobState` from `@ultimat3/jobs`, which exports the type but no runtime list. */
export const JOB_STATES: readonly JobState[] = [
  'ready',
  'delayed',
  'running',
  'suspended',
  'done',
  'failed',
  'dead',
];

const isJobState = (value: string): value is JobState =>
  (JOB_STATES as readonly string[]).includes(value);

export function parseStateFlag(value: string | undefined): JobState | undefined {
  if (value === undefined) return undefined;
  if (isJobState(value)) return value;
  throw new BadFlagError({
    flag: 'state',
    command: 'jobs',
    reason: `unknown state "${value}" (known: ${JOB_STATES.join(', ')})`,
  });
}

export function parseLimitFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new BadFlagError({
      flag: 'limit',
      command: 'jobs',
      reason: `expects a positive integer, got "${value}"`,
    });
  }
  return Number.parseInt(value, 10);
}

// ── ls ────────────────────────────────────────────────────────────────────

export interface JobsListFilter {
  readonly queue?: string | undefined;
  readonly state?: string | undefined;
  readonly name?: string | undefined;
  readonly limit?: string | undefined;
}

export interface JobsListResult {
  readonly depth: QueueDepthReport;
  readonly rows: readonly JobRecord[];
  readonly deadLetters: readonly DeadLetterEntry[];
}

/**
 * The depth report AND the filtered rows, plus dead letters unconditionally: a dead job that a
 * `--state ready` filter (or the default 100-row cap) pushes out of view is the exact failure
 * mode this command exists to prevent.
 */
export async function listJobs(
  driver: JobDriver,
  filter: JobsListFilter = {},
): Promise<JobsListResult> {
  const state = parseStateFlag(filter.state);
  const limit = parseLimitFlag(filter.limit);
  const jobFilter: JobFilter = {
    ...(filter.queue === undefined ? {} : { queue: filter.queue }),
    ...(filter.name === undefined ? {} : { name: filter.name }),
    ...(state === undefined ? {} : { state }),
    ...(limit === undefined ? {} : { limit }),
  };
  const [depth, rows, deadLetters] = await Promise.all([
    inspectQueues(driver),
    inspectJobList(driver, jobFilter),
    inspectDeadLetters(driver),
  ]);
  return { depth, rows, deadLetters };
}

// ── show ──────────────────────────────────────────────────────────────────

export async function showJob(driver: JobDriver, id: string): Promise<JobTrace> {
  const trace = await inspectJob(driver, id);
  if (trace === undefined) throw new JobUnknownError({ id, driver: driver.name });
  return trace;
}

// ── retry ─────────────────────────────────────────────────────────────────

/**
 * Existence is checked up front so an unknown id always surfaces as `X_JOB_UNKNOWN`: the
 * concrete drivers (pg, memory) throw their own error from inside `requeue()` for a missing
 * row, and that error is not this command's contract — `retryFromStep`'s documented `undefined`
 * return is, and the driver never reaches it once the row is already known absent.
 */
export async function retryJob(
  driver: JobDriver,
  id: string,
  fromStep?: string,
): Promise<JobTrace> {
  const existing = await inspectJob(driver, id);
  if (existing === undefined) throw new JobUnknownError({ id, driver: driver.name });
  const trace = await retryFromStep(driver, id, fromStep);
  if (trace === undefined) throw new JobUnknownError({ id, driver: driver.name });
  return trace;
}

// ── drain ─────────────────────────────────────────────────────────────────

/** `running` is deliberately excluded: a job a worker is mid-execution on is not "pending". */
const PENDING_STATES: readonly JobState[] = ['ready', 'delayed', 'suspended'];

export interface DrainFailure {
  readonly id: string;
  readonly name: string;
  readonly finding: Finding;
}

export interface DrainOutcome {
  readonly from: string;
  readonly to: string;
  readonly dryRun: boolean;
  readonly candidates: readonly JobRecord[];
  readonly moved: readonly JobRecord[];
  readonly failures: readonly DrainFailure[];
}

/**
 * Move every pending job from `source` onto `target`. `--dry-run` reports the candidate list and
 * enqueues nothing. Per-record try/catch, not a batch operation: one record that cannot enqueue
 * on the target (a redis/nats stub, a transient error) must not stop the rest from moving, and
 * the caller reports each failure as its own finding.
 */
export async function drainJobs(
  source: JobDriver,
  target: JobDriver,
  dryRun: boolean,
): Promise<DrainOutcome> {
  const lists = await Promise.all(PENDING_STATES.map((state) => inspectJobList(source, { state })));
  const candidates = lists.flat();
  if (dryRun) {
    return {
      from: source.name,
      to: target.name,
      dryRun: true,
      candidates,
      moved: [],
      failures: [],
    };
  }

  const moved: JobRecord[] = [];
  const failures: DrainFailure[] = [];
  for (const record of candidates) {
    try {
      // Enqueue on the target BEFORE ack'ing the source: at-least-once delivery. A crash between
      // the two calls leaves the job live on both drivers, and `idempotencyKey` dedupes the
      // duplicate wherever it is reprocessed. Ack'ing first and then crashing before the enqueue
      // would drop the job with nothing left to replay it from.
      await target.enqueue({
        name: record.name,
        queue: record.queue,
        input: record.input,
        idempotencyKey: record.idempotencyKey,
        runId: record.runId,
        maxAttempts: record.maxAttempts,
        runAt: record.runAt,
        ...(record.tenantId === undefined ? {} : { tenantId: record.tenantId }),
      });
      await source.ack(record.id);
      moved.push(record);
    } catch (error) {
      failures.push({ id: record.id, name: record.name, finding: findingFrom(error) });
    }
  }
  return { from: source.name, to: target.name, dryRun: false, candidates, moved, failures };
}

// ── JSON projections — `data` is plain JSON: no `undefined`, no bare `unknown` ─────────────────

function stepTraceToJson(step: StepTrace): JsonValue {
  return {
    name: step.name,
    status: step.status,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    wakeAt: step.wakeAt,
    durationMs: step.durationMs,
    attempts: step.attempts,
    error: step.error,
  };
}

export function jobTraceToJson(trace: JobTrace): JsonValue {
  return {
    id: trace.id,
    name: trace.name,
    queue: trace.queue,
    state: trace.state,
    attempt: trace.attempt,
    maxAttempts: trace.maxAttempts,
    idempotencyKey: trace.idempotencyKey,
    runId: trace.runId,
    runAt: trace.runAt,
    lastError: trace.lastError,
    tenantId: trace.tenantId,
    steps: trace.steps.map(stepTraceToJson),
    retryDelaysMs: trace.retryDelaysMs.map((ms) => ms),
  };
}

/**
 * `input` is deliberately excluded: it is `unknown` at the driver boundary (an app-defined
 * payload, not something this package can prove is JSON-safe), and `JobTrace` already sets the
 * precedent of leaving it out of every JSON-facing projection.
 */
export function jobRecordToJson(record: JobRecord): JsonValue {
  return {
    id: record.id,
    name: record.name,
    queue: record.queue,
    state: record.state,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    idempotencyKey: record.idempotencyKey,
    runId: record.runId,
    runAt: record.runAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    tenantId: record.tenantId ?? null,
    lastError: record.lastError ?? null,
    claimedBy: record.claimedBy ?? null,
    visibleAt: record.visibleAt ?? null,
  };
}

function queueStatsToJson(stats: QueueStats): JsonValue {
  return {
    queue: stats.queue,
    ready: stats.ready,
    delayed: stats.delayed,
    running: stats.running,
    suspended: stats.suspended,
    dead: stats.dead,
    oldestReadyMs: stats.oldestReadyMs,
  };
}

export function depthToJson(depth: QueueDepthReport): JsonValue {
  return {
    driver: depth.driver,
    queues: depth.queues.map(queueStatsToJson),
    totals: {
      ready: depth.totals.ready,
      delayed: depth.totals.delayed,
      running: depth.totals.running,
      suspended: depth.totals.suspended,
      dead: depth.totals.dead,
    },
    oldestReadyMs: depth.oldestReadyMs,
  };
}

export function deadLetterToJson(entry: DeadLetterEntry): JsonValue {
  return {
    id: entry.id,
    name: entry.name,
    queue: entry.queue,
    attempt: entry.attempt,
    lastError: entry.lastError,
    failedAt: entry.failedAt,
    retryCommand: entry.retryCommand,
  };
}

export function drainFailureToJson(failure: DrainFailure): JsonValue {
  return {
    id: failure.id,
    name: failure.name,
    finding: {
      code: failure.finding.code,
      cause: failure.finding.cause,
      fix: failure.finding.fix,
      docs: failure.finding.docs ?? null,
      at: failure.finding.at ?? null,
    },
  };
}

// ── table ─────────────────────────────────────────────────────────────────

/** Fixed-width columns, same padding idiom as `renderRouteTable` in `cmd-routes.ts`. */
export function renderJobTable(rows: readonly JobRecord[]): readonly string[] {
  const body = rows.map((row) => [
    row.id,
    row.name,
    row.queue,
    row.state,
    String(row.attempt),
    new Date(row.runAt).toISOString(),
  ]);
  const header = ['id', 'name', 'queue', 'state', 'attempt', 'run-at'];
  const widths = header.map((title, index) =>
    Math.max(title.length, ...body.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ');
  return [line(header), ...body.map(line)];
}
