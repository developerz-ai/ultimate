// What one enqueue WRITES, built once for every path: the staged `OutboxRecord` and the direct
// `EnqueueRequest`, for `enqueue` and `enqueueMany` alike. Split from `outbox.ts` so the batch path
// builds the identical row the single one does, instead of a second spelling of it.

import { currentSpanContext, describeValue, traceparent, UltimateError } from '@ultimat3/core';
import type { EnqueueRequest } from './driver';
import { DEFAULT_QUEUE } from './driver';
import type { JobHandle } from './job';
import type { EnqueueOptions, OutboxRecord } from './outbox';

/**
 * The W3C `traceparent` of the span this enqueue is happening inside, or `undefined` outside a
 * trace. This is the ONE place the link is minted: `docs/idea/04-jobs.md` promises a job trace
 * linked to the enqueuing request, and before this there was no field to carry the link, so a
 * checkout's `chargeCard` opened a fresh root two seconds later with nothing pointing back.
 *
 * A context recovered from a `Ctx` has an empty `spanId` (`currentSpanContext`), which renders as
 * an all-zero parent that every collector rejects — so that case carries no header rather than a
 * malformed one, and the job opens a root as it did before.
 */
export function ambientTraceparent(): string | undefined {
  const context = currentSpanContext();
  if (context === undefined || context.spanId === '') return undefined;
  return traceparent(context);
}

/** What Postgres prints for a `uuid`, and so the only spelling both drivers store identically. */
const RUN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `EnqueueOptions.runId`, refused HERE when it is not a uuid — the one screen both enqueue paths
 * read. `run_id` is a `uuid` column: the memory driver took any string, Postgres raised a raw
 * `22P02`, and on the staged path that was the caller's whole transaction failing at the outbox
 * insert. Any version, lowercase: an uppercase one would come back from Postgres re-spelled.
 */
export function namedRunId(job: string, runId: unknown): string | undefined {
  if (runId === undefined) return undefined;
  if (typeof runId === 'string' && RUN_ID_SHAPE.test(runId)) return runId;
  throw new UltimateError({
    code: 'X_ID_INVALID',
    // `describeValue`, never the value: what arrives here wrong is as often a key as a typo.
    cause: `enqueue of job "${job}" was given runId ${describeValue(runId)}, and a run id is a lowercase uuid (8-4-4-4-12 hex) — the queue stores it in a uuid column`,
    fix: "pass { runId: uuidV7() } to enqueue(), with import { uuidV7 } from '@ultimat3/core'",
    meta: { job, option: 'runId' },
  });
}

/** The parts of one row the caller of the builders decides: its key, its clock, its ids. */
export interface RowFacts {
  readonly idempotencyKey: string;
  readonly at: number;
  readonly trace: string | undefined;
  readonly id?: string;
  readonly runId?: string;
}

const optional = (options: EnqueueOptions, trace: string | undefined) => ({
  ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
  ...(trace === undefined ? {} : { traceparent: trace }),
  ...(options.enqueuedBy === undefined ? {} : { enqueuedBy: options.enqueuedBy }),
});

/** The row a staged enqueue writes to the outbox; its `id` and `runId` are the job's to be. */
export function stagedRecord<I>(
  handle: JobHandle<I>,
  input: I,
  options: EnqueueOptions,
  facts: RowFacts & { readonly id: string; readonly runId: string },
): OutboxRecord {
  return {
    id: facts.id,
    runId: facts.runId,
    job: handle.name,
    queue: options.queue ?? handle.queue ?? DEFAULT_QUEUE,
    input,
    idempotencyKey: facts.idempotencyKey,
    maxAttempts: handle.retry.attempts,
    runAt: options.runAt ?? facts.at,
    stagedAt: facts.at,
    // Stamped at STAGE time and not at publish time: the relay runs after commit, in its own
    // timer, with no request span in scope — a trace read there would be nobody's.
    ...optional(options, facts.trace),
  };
}

/** The request a direct enqueue hands the driver. Ids only when the caller allocated them. */
export function directRequest<I>(
  handle: JobHandle<I>,
  input: I,
  options: EnqueueOptions,
  facts: RowFacts,
): EnqueueRequest {
  return {
    ...(facts.id === undefined ? {} : { id: facts.id }),
    name: handle.name,
    queue: options.queue ?? handle.queue,
    input,
    idempotencyKey: facts.idempotencyKey,
    maxAttempts: handle.retry.attempts,
    runAt: options.runAt ?? facts.at,
    ...(facts.runId === undefined ? {} : { runId: facts.runId }),
    ...optional(options, facts.trace),
  };
}

/** The request the relay publishes a staged row as — under the ids the stage answered. */
export function publishRequest(record: OutboxRecord): EnqueueRequest {
  return {
    // A repeat of this publish — a crash before the mark — meets the job this one made.
    id: record.id,
    runId: record.runId,
    name: record.job,
    queue: record.queue,
    input: record.input,
    idempotencyKey: record.idempotencyKey,
    maxAttempts: record.maxAttempts,
    runAt: record.runAt,
    ...(record.tenantId === undefined ? {} : { tenantId: record.tenantId }),
    ...(record.traceparent === undefined ? {} : { traceparent: record.traceparent }),
    ...(record.enqueuedBy === undefined ? {} : { enqueuedBy: record.enqueuedBy }),
  };
}
