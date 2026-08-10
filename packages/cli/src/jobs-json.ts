// Every `--json` projection behind `x jobs`, and nothing else. Split out of `jobs-report.ts`:
// `data` must be plain JSON — no `undefined`, no bare `unknown` — and that rule is only
// enforceable if the projections sit together where one missing `?? null` is visible.

import type {
  DeadLetterEntry,
  JobRecord,
  JobTrace,
  QueueDepthReport,
  QueueStats,
  StepTrace,
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
