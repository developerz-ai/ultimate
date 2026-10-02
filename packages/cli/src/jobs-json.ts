// Every `--json` projection behind `x jobs`, and nothing else. Split out of `jobs-report.ts`:
// `data` must be plain JSON — no `undefined`, no bare `unknown` — and that rule is only
// enforceable if the projections sit together where one missing `?? null` is visible.

import type {
  BackfillProgress,
  DeadLetterEntry,
  JobRecord,
  JobTrace,
  PausedName,
  QueueDepthReport,
  QueueStats,
  StepTrace,
  WorkerRecord,
} from '@ultimat3/jobs';
import type { DrainFailure, DrainSkip } from './jobs-drain';
import type { JsonValue } from './output';

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

/**
 * One `x_backfills` row. Every absent value is already `null` at the source (`toBackfillProgress`
 * makes it so), which is what lets this be a straight field list — and it is spelled out rather
 * than spread so a field added upstream arrives here as a decision, not as untyped passthrough.
 */
export function backfillToJson(progress: BackfillProgress): JsonValue {
  return {
    runId: progress.runId,
    name: progress.name,
    status: progress.status,
    checksum: progress.checksum,
    appVersion: progress.appVersion,
    rows: progress.rows,
    cursor: progress.cursor,
    startedAt: progress.startedAt,
    completedAt: progress.completedAt,
    durationMs: progress.durationMs,
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
    // The failure's stack, bounded by the queue. `null` when the thrown value carried none.
    stack: trace.stack,
    // The payload with every key the app declared secret already replaced (`redactInput`), so it
    // is the queue's promise that this is safe to print — never this file's.
    input: toJson(trace.input),
    progress:
      trace.progress === null
        ? null
        : {
            done: trace.progress.done,
            total: trace.progress.total,
            note: trace.progress.note ?? null,
            at: trace.progress.at,
          },
    tenantId: trace.tenantId,
    steps: trace.steps.map(stepTraceToJson),
    retryDelaysMs: trace.retryDelaysMs.map((ms) => ms),
    // `concurrency.key(input)` for a keyed job, `null` for every other: which lease this run waits on.
    concurrencyKey: trace.concurrencyKey,
    // `null` for every job that is not a `backfill()` pass. Dropped, `x jobs show <id> --json`
    // would answer "how far has it got" with silence for the one job kind that can say.
    backfill: trace.backfill === null ? null : backfillToJson(trace.backfill),
  };
}

/**
 * An app payload as plain JSON. A round trip through the serialiser is the proof: whatever a
 * payload held that JSON cannot carry — a bigint, a function, a cycle — degrades to `null` rather
 * than failing the command that was asked to show it.
 */
function toJson(value: unknown): JsonValue {
  try {
    const text: string | undefined = JSON.stringify(value);
    return text === undefined ? null : (JSON.parse(text) as JsonValue);
  } catch {
    return null;
  }
}

export function pausedToJson(paused: PausedName): JsonValue {
  return { name: paused.name, pausedAt: paused.pausedAt };
}

export function workerToJson(worker: WorkerRecord): JsonValue {
  return {
    id: worker.id,
    host: worker.host,
    startedAt: worker.startedAt,
    heartbeatAt: worker.heartbeatAt,
    queues: [...worker.queues],
    concurrency: worker.concurrency,
    inFlight: [...worker.inFlight],
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
    failed: stats.failed,
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
      failed: depth.totals.failed,
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

/** A candidate the drain refused to touch, and why — the half of the outcome `moved` cannot show. */
export function drainSkipToJson(skip: DrainSkip): JsonValue {
  return {
    id: skip.id,
    name: skip.name,
    queue: skip.queue,
    state: skip.state,
    reason: skip.reason,
  };
}
