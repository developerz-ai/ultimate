// The transactional outbox. `ctx.jobs.enqueue()` inside a request writes the job row in the SAME
// `tx` as the business rows and a relay publishes it after commit. Without it, every enqueue is a
// distributed-transaction coin flip:
//
//   enqueue then rollback  -> the job runs against rows that never existed
//   commit then enqueue    -> the process dies in between and the job is lost forever
//
// Both are load-dependent, both pass every test, and both are the top source of "the email
// went out but the order isn't in the database" tickets. Joining the transaction removes the
// window entirely; the relay's at-least-once delivery is deduped by the job's idempotencyKey.
//
// **It is NOT on by default, and this header used to claim it was** (`As of 2026-08`). Three
// things have to be true in a process for an enqueue to be transactional, and the fallback at
// `jobsFacade()` is what happens when they are not:
//
//   1. `x_outbox` exists — it ships in `SQL_JOBS_TABLE` now, so applying the queue DDL is enough.
//   2. `setJobsFacade(outboxJobsFacade({ store, driver }, currentTx))` ran at boot, with a store
//      from `postgresOutboxStore` and a REAL `currentTx` accessor.
//   3. `outboxRelay({ store, driver }).start()` is running somewhere.
//
// With none of them, `jobsFacade()` answers the fallback below, whose `currentTx` is
// `() => undefined`: every enqueue publishes straight to the driver, outside the caller's
// transaction, and both failure modes above are live. That fallback is deliberate — a script, a
// test and `x dev` must enqueue with nothing wired — but it is a fallback, not the guarantee.

import type { Clock } from '@ultimat3/core';
import { uuidV7 } from '@ultimat3/core';
import { refuseAbandoned } from '@ultimat3/db';
import type { Tx } from '@ultimat3/entity';
import { nowMs } from './clock';
import type { EnqueueResult, JobDriver } from './driver';
import { jobDriver } from './driver';
import { ambientTraceparent, directRequest, namedRunId, stagedRecord } from './enqueue-record';
import { signalEnqueued, signalStaged } from './enqueue-signal';
import { DriverUnavailableError, OutboxNoTxError } from './errors';
import type { JobHandle } from './job';
import type { EnqueueManyOptions } from './job-enqueue-many';
import { enqueueMany } from './job-enqueue-many';
import { resolveClaimLeaseMs } from './outbox-lease';
import { refuseEnqueueTenant } from './tenant';

export interface OutboxRecord {
  /** The outbox row's id AND the id of the job its publish creates: allocated once, at stage. */
  readonly id: string;
  /** The run the published job carries. Allocated at stage, so the enqueue could answer it. */
  readonly runId: string;
  readonly job: string;
  readonly queue: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
  readonly runAt: number;
  readonly stagedAt: number;
  readonly tenantId?: string;
  /** The enqueuing request's trace, carried across the relay so the job's span still has a parent. */
  readonly traceparent?: string;
  readonly enqueuedBy?: string;
  readonly publishedAt?: number;
  /**
   * Stamped by `claim()`, absent on a staged row. Hand it back to `release`/`markPublished`: it is
   * the FENCE, so a claimant whose lease lapsed cannot touch the rows a newer one is publishing.
   */
  readonly claimedBy?: string;
}

export interface OutboxStore {
  /** Write inside `tx`. Nothing is visible to the relay until that tx commits. */
  stage(tx: Tx, record: OutboxRecord): Promise<void>;
  /**
   * Stage every record in ONE write, in order — `enqueueMany`'s chunk. OPTIONAL, like `release`:
   * absent, the facade calls `stage` once per record, which is correct and slower.
   */
  stageMany?(tx: Tx, records: readonly OutboxRecord[]): Promise<void>;
  /** Called by the tx runner after COMMIT. */
  commit(tx: Tx): Promise<readonly OutboxRecord[]>;
  /** Called by the tx runner after ROLLBACK. Staged rows vanish with the transaction. */
  rollback(tx: Tx): Promise<void>;
  /**
   * CLAIM unpublished, committed rows — the relay's work queue, and a lease rather than a read.
   * A store that hands the same rows to two relays hands the same job to two workers, and the
   * idempotency key only collapses that while the first job is still live.
   */
  claim(limit: number): Promise<readonly OutboxRecord[]>;
  /**
   * Hand a claim back before its lease runs out, for the batch a failed publish stopped. OPTIONAL
   * so a store written before the claim became a lease still compiles: without it those rows wait
   * out the whole lease, which is slower, never wrong.
   *
   * `claimant` is the `claimedBy` the claim stamped. Passing it is what makes a lapsed relay's
   * late release a no-op instead of an unclaim of somebody else's live batch.
   */
  release?(ids: readonly string[], claimant?: string): Promise<void>;
  /** `claimant` fences the same way, and here it is worse to miss: this retires the row. */
  markPublished(id: string, at: number, claimant?: string): Promise<void>;
  /**
   * `markPublished` for a whole published batch in one write, under the same fence. OPTIONAL: the
   * relay publishes a batch through `JobDriver.enqueueMany` only when the store has this too.
   */
  markPublishedMany?(ids: readonly string[], at: number, claimant?: string): Promise<void>;
  pendingCount(): Promise<number>;
}

/**
 * The claim's sort key, and it is TOTAL: `id` after `stagedAt`, exactly what `SQL_OUTBOX_CLAIM`
 * orders by. Every row staged in one transaction shares a `stagedAt`, so the key ties for the
 * batch that most depends on order — and a tie leaves both which rows a limit takes and the order
 * they publish in to whatever the store iterated first. Code units, never `localeCompare`, for
 * the reason `registeredJobs()` sorts that way.
 */
function byClaimOrder(a: OutboxRecord, b: OutboxRecord): number {
  if (a.stagedAt !== b.stagedAt) return a.stagedAt - b.stagedAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export interface MemoryOutboxStoreOptions {
  readonly clock?: Clock;
  readonly claimLeaseMs?: number;
}

export interface MemoryOutboxStore extends OutboxStore {
  /**
   * Committed rows this process is still holding. The relay's backlog and nothing else — a
   * published row is dropped, so this is a bound, not a total. `x dev` and the tests are the
   * only readers; a pg deployment reads `x_outbox` instead.
   */
  retained(): number;
}

/**
 * Default store. Staged rows hang off the `Tx` object itself in a WeakMap, so the "same
 * transaction" guarantee needs no cooperation from the DB layer and rollback is a delete.
 * The pg store swaps this for a real `x_outbox` table written by the same connection.
 */
export function memoryOutboxStore(options: MemoryOutboxStoreOptions = {}): MemoryOutboxStore {
  const staged = new WeakMap<object, OutboxRecord[]>();
  const committed = new Map<string, OutboxRecord>();
  /** Each claimed row's lease: when it was taken and by whom. Absent is `claimed_at is null`. */
  const claims = new Map<string, { at: number; by: string }>();
  const leaseMs = resolveClaimLeaseMs(options.claimLeaseMs);
  // A token per CLAIM, where the pg store stamps one per RELAY. Two relays there are two stores
  // with two ids; here they are two `claim()` calls on one store, so the claim is the only
  // granularity at which this store can answer "is this mutation from the current holder".
  let claimSeq = 0;

  const key = (tx: Tx): object => tx as unknown as object;
  const free = (id: string, at: number): boolean => {
    const claim = claims.get(id);
    return claim === undefined || at - claim.at >= leaseMs;
  };
  /**
   * A mutation from a claimant that no longer holds the row is a NO-OP. `undefined` is the caller
   * that holds no token at all — a store-level caller, or one written before the fence — and is
   * left unfenced rather than silently dropped, the way `release` itself is optional.
   */
  const owns = (id: string, claimant: string | undefined): boolean =>
    claimant === undefined || claims.get(id)?.by === claimant;

  return {
    stage(tx, record) {
      const bucket = staged.get(key(tx)) ?? [];
      bucket.push(record);
      staged.set(key(tx), bucket);
      return Promise.resolve();
    },
    stageMany(tx, records) {
      const bucket = staged.get(key(tx)) ?? [];
      bucket.push(...records);
      staged.set(key(tx), bucket);
      return Promise.resolve();
    },
    commit(tx) {
      const bucket = staged.get(key(tx)) ?? [];
      staged.delete(key(tx));
      for (const record of bucket) committed.set(record.id, record);
      return Promise.resolve(bucket);
    },
    rollback(tx) {
      staged.delete(key(tx));
      return Promise.resolve();
    },
    /**
     * The same question `SQL_OUTBOX_CLAIM` answers, and it has to stay the same one: a row this
     * store hands back is CLAIMED for `leaseMs`, so a second relay polling the same store gets
     * nothing, and a claim whose holder died is reclaimable once the window passes.
     */
    claim(limit) {
      const at = nowMs(options.clock);
      claimSeq += 1;
      const by = `claim-${claimSeq}`;
      const ready = [...committed.values()]
        .filter((record) => record.publishedAt === undefined && free(record.id, at))
        .sort(byClaimOrder)
        .slice(0, limit);
      for (const record of ready) claims.set(record.id, { at, by });
      return Promise.resolve(ready.map((record) => ({ ...record, claimedBy: by })));
    },
    release(ids, claimant) {
      for (const id of ids) {
        if (owns(id, claimant)) claims.delete(id);
      }
      return Promise.resolve();
    },
    markPublished(id, _at, claimant) {
      if (!owns(id, claimant)) return Promise.resolve();
      // Deleted, not stamped. A published row is out of the relay's reach either way, and the
      // pg store's `published_at` column is a retained audit trail this map is not: rewriting
      // it in place held every payload ever enqueued — arbitrary job input — for the life of
      // the process, and made `claim()` and `pendingCount()` walk all of them every 200ms.
      committed.delete(id);
      claims.delete(id);
      return Promise.resolve();
    },
    markPublishedMany(ids, _at, claimant) {
      for (const id of ids) {
        if (!owns(id, claimant)) continue;
        committed.delete(id);
        claims.delete(id);
      }
      return Promise.resolve();
    },
    pendingCount() {
      let count = 0;
      for (const record of committed.values()) {
        if (record.publishedAt === undefined) count += 1;
      }
      return Promise.resolve(count);
    },
    retained: () => committed.size,
  };
}

export interface EnqueueOptions {
  /** Epoch ms, or a delay off the caller's own clock: `clock.now().getTime() + toMs('5m')`. */
  readonly runAt?: number;
  readonly tenantId?: string;
  readonly queue?: string;
  /** Escape hatch for enqueues that must fire regardless of the caller's transaction. */
  readonly outbox?: boolean;
  /**
   * Who asked. AUDIT ONLY — the job body still runs with system authority. `handle.as(actor, ...)`
   * fills it from the actor; set it directly only where there is no actor object to hand over.
   */
  readonly enqueuedBy?: string;
  /** Override the ambient trace. Almost never: the facade stamps the current span for you. */
  readonly traceparent?: string;
  /**
   * Name the run instead of having one minted: a uuid the caller already wrote somewhere — the
   * row its own table keys the run by. `EnqueueResult.runId` answers it back either way.
   */
  readonly runId?: string;
}

export interface OutboxDeps {
  readonly store: OutboxStore;
  readonly driver: JobDriver;
  readonly clock?: Clock;
  /** `'required'` fails an out-of-transaction enqueue instead of publishing it directly. */
  readonly mode?: 'default' | 'required';
}

/**
 * Stage a job inside `tx`. Returns the row that the relay will publish after commit.
 *
 * The facade's staged arm, and NOT in `index.ts`: the refusals (`refuseAbandoned`, the concurrency
 * key, `refuseEnqueueTenant`) are the facade's and precede this call, so a public spelling of it
 * was a second enqueue path that staged rows the facade refuses. Exported for this package's tests.
 */
export async function enqueueInTx<I>(
  deps: OutboxDeps,
  tx: Tx,
  handle: JobHandle<I>,
  input: I,
  options: EnqueueOptions = {},
): Promise<OutboxRecord> {
  const runId = namedRunId(handle.name, options.runId);
  const record = stagedRecord(handle, input, options, {
    id: uuidV7(),
    runId: runId ?? uuidV7(),
    idempotencyKey: handle.idempotencyKeyFor(input),
    at: nowMs(deps.clock),
    trace: options.traceparent ?? ambientTraceparent(),
  });
  await deps.store.stage(tx, record);
  // Wakes a relay in THIS process that has backed off; a relay elsewhere polls on its own.
  signalStaged();
  return record;
}

export interface JobsFacade {
  /**
   * Joins the ambient transaction when there is one. Same call site in a request handler,
   * a job, or a script — the transactional behaviour is the framework's problem, not yours.
   */
  enqueue<I>(handle: JobHandle<I>, input: I, options?: EnqueueOptions): Promise<EnqueueResult>;
  /** Many of one job, one statement per chunk, answered in input order (`job-enqueue-many.ts`). */
  enqueueMany<I>(
    handle: JobHandle<I>,
    inputs: readonly I[],
    options?: EnqueueManyOptions,
  ): Promise<readonly EnqueueResult[]>;
}

export function outboxJobsFacade(deps: OutboxDeps, currentTx: () => Tx | undefined): JobsFacade {
  return {
    async enqueue<I>(
      handle: JobHandle<I>,
      input: I,
      options: EnqueueOptions = {},
    ): Promise<EnqueueResult> {
      // A direct `driver.enqueue` is a write the transaction guard cannot see: a scope whose caller
      // was already answered starts no job, on either path below.
      refuseAbandoned();
      // Asked before anything is staged, and for its refusal alone: a `concurrency.key` that
      // answers an empty string is one lock shared by every run of the job, and the caller of
      // this enqueue is the only one who can still be told (`X_JOB_DECLARATION_INVALID`).
      handle.concurrencyKeyFor(input);
      // A payload naming one org, enqueued for — or by an actor of — another (`tenant.ts`).
      refuseEnqueueTenant(handle.name, handle.tenantFor(input), options.tenantId);
      const tx = options.outbox === false ? undefined : currentTx();

      if (tx === undefined) {
        if (deps.mode === 'required' && options.outbox !== false) {
          throw new OutboxNoTxError({ job: handle.name });
        }
        const runId = namedRunId(handle.name, options.runId);
        const trace = options.traceparent ?? ambientTraceparent();
        const result = await deps.driver.enqueue(
          directRequest(handle, input, options, {
            idempotencyKey: handle.idempotencyKeyFor(input),
            at: nowMs(deps.clock),
            trace,
            ...(runId === undefined ? {} : { runId }),
          }),
        );
        // A worker in this process that has backed off starts its next pass now.
        signalEnqueued(options.queue ?? handle.queue);
        return result;
      }

      const record = await enqueueInTx(deps, tx, handle, input, options);
      // The job does not exist until COMMIT, but its ids do: both were allocated at stage time
      // and the relay publishes under them, so a caller can say which run it started. `deduped`
      // is the one thing only the publish can know — a staged enqueue whose idempotency key a
      // LIVE job holds creates nothing, and these ids then name no row.
      return { id: record.id, runId: record.runId, deduped: false };
    },
    enqueueMany<I>(handle: JobHandle<I>, inputs: readonly I[], options: EnqueueManyOptions = {}) {
      const tx = options.outbox === false ? undefined : currentTx();
      return enqueueMany(deps, tx, handle, inputs, options);
    },
  };
}

let ambient: JobsFacade | undefined;
let fallback: JobsFacade | undefined;

/**
 * Installed once at boot, next to `setJobDriver`, with the app's outbox store and its
 * transaction accessor. `handle.enqueue()` then joins the caller's transaction wherever it is
 * called from — which is the only reason the outbox protects anything.
 */
export function setJobsFacade(facade: JobsFacade | null): void {
  ambient = facade ?? undefined;
}

/**
 * The one enqueue path. With no facade installed the fallback publishes straight to the
 * ambient driver, so a script, a test or `x dev` enqueues without wiring anything — an app
 * that installed the outbox gets the outbox, at the same call site.
 */
export function jobsFacade(): JobsFacade {
  if (ambient !== undefined) return ambient;
  fallback ??= outboxJobsFacade(
    {
      // A getter, not a snapshot: `setJobDriver()` after the first enqueue is honoured, and a
      // missing driver is an error at the call rather than at import time.
      get driver(): JobDriver {
        const installed = jobDriver();
        if (installed === undefined) {
          throw new DriverUnavailableError({
            driver: 'none',
            cause: 'no queue driver is installed in this process',
            fix: 'call setJobDriver(memoryJobDriver()) before enqueuing, or setJobDriver(postgresJobDriver()) for a real queue',
          });
        }
        return installed;
      },
      // Unreachable while `currentTx` is `() => undefined`; present because `OutboxDeps`
      // requires a store, and a real one is cheaper than an assertion that cannot fire.
      store: memoryOutboxStore(),
    },
    () => undefined,
  );
  return fallback;
}

/** Test/CLI seam, the counterpart to `resetJobDriver()`: forget the installed facade. */
export function resetJobsFacade(): void {
  ambient = undefined;
}

// The outbox's SQL moved to `driver-pg-sql.ts`, where every statement this package runs lives —
// and, more to the point, where `SQL_JOBS_TABLE` is: `x_outbox` was declared here, in a constant
// no boot code applied, which is the whole reason the outbox was documented and never created.
// `src/index.ts` still re-exports the same four names, from there.
