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
//   2. `setJobsFacade(createJobsFacade({ store, driver }, currentTx))` ran at boot, with a store
//      from `createPgOutboxStore` and a REAL `currentTx` accessor.
//   3. `createOutboxRelay({ store, driver }).start()` is running somewhere.
//
// With none of them, `jobsFacade()` answers the fallback below, whose `currentTx` is
// `() => undefined`: every enqueue publishes straight to the driver, outside the caller's
// transaction, and both failure modes above are live. That fallback is deliberate — a script, a
// test and `x dev` must enqueue with nothing wired — but it is a fallback, not the guarantee.

import type { Clock } from '@ultimat3/core';
import { currentSpanContext, logger, traceparent, uuid } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import { nowMs } from './clock';
import type { EnqueueResult, JobDriver } from './driver';
import { DEFAULT_QUEUE, jobDriver } from './driver';
import { DriverUnavailableError, OutboxNoTxError } from './errors';
import type { JobHandle } from './job';
import { resolveClaimLeaseMs } from './outbox-lease';

export interface OutboxRecord {
  readonly id: string;
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

export interface MemoryOutboxOptions {
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
export function createMemoryOutboxStore(options: MemoryOutboxOptions = {}): MemoryOutboxStore {
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
  /** Epoch ms, or a delay via `runAt: nowMs() + toMs('5m')`. */
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
}

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
function ambientTraceparent(): string | undefined {
  const context = currentSpanContext();
  if (context === undefined || context.spanId === '') return undefined;
  return traceparent(context);
}

export interface OutboxDeps {
  readonly store: OutboxStore;
  readonly driver: JobDriver;
  readonly clock?: Clock;
  /** `'required'` fails an out-of-transaction enqueue instead of publishing it directly. */
  readonly mode?: 'default' | 'required';
}

/** Stage a job inside `tx`. Returns the row that the relay will publish after commit. */
export function enqueueInTx<I>(
  deps: OutboxDeps,
  tx: Tx,
  handle: JobHandle<I>,
  input: I,
  options: EnqueueOptions = {},
): Promise<OutboxRecord> {
  const at = nowMs(deps.clock);
  const trace = options.traceparent ?? ambientTraceparent();
  const record: OutboxRecord = {
    id: uuid(),
    job: handle.name,
    queue: options.queue ?? handle.queue ?? DEFAULT_QUEUE,
    input,
    idempotencyKey: handle.idempotencyKeyFor(input),
    maxAttempts: handle.retry.attempts,
    runAt: options.runAt ?? at,
    stagedAt: at,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    // Stamped at STAGE time and not at publish time: the relay runs after commit, in its own
    // timer, with no request span in scope — a trace read there would be nobody's.
    ...(trace === undefined ? {} : { traceparent: trace }),
    ...(options.enqueuedBy === undefined ? {} : { enqueuedBy: options.enqueuedBy }),
  };
  return deps.store.stage(tx, record).then(() => record);
}

export interface JobsFacade {
  /**
   * Joins the ambient transaction when there is one. Same call site in a request handler,
   * a job, or a script — the transactional behaviour is the framework's problem, not yours.
   */
  enqueue<I>(handle: JobHandle<I>, input: I, options?: EnqueueOptions): Promise<EnqueueResult>;
}

const STAGED_RESULT: EnqueueResult = { id: '', runId: '', deduped: false };

export function createJobsFacade(deps: OutboxDeps, currentTx: () => Tx | undefined): JobsFacade {
  return {
    async enqueue<I>(
      handle: JobHandle<I>,
      input: I,
      options: EnqueueOptions = {},
    ): Promise<EnqueueResult> {
      const tx = options.outbox === false ? undefined : currentTx();

      if (tx === undefined) {
        if (deps.mode === 'required' && options.outbox !== false) {
          throw new OutboxNoTxError({ job: handle.name });
        }
        const trace = options.traceparent ?? ambientTraceparent();
        return deps.driver.enqueue({
          name: handle.name,
          queue: options.queue ?? handle.queue,
          input,
          idempotencyKey: handle.idempotencyKeyFor(input),
          maxAttempts: handle.retry.attempts,
          runAt: options.runAt ?? nowMs(deps.clock),
          ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
          ...(trace === undefined ? {} : { traceparent: trace }),
          ...(options.enqueuedBy === undefined ? {} : { enqueuedBy: options.enqueuedBy }),
        });
      }

      const record = await enqueueInTx(deps, tx, handle, input, options);
      // No queue id yet by design: the row does not exist until COMMIT.
      return { ...STAGED_RESULT, id: record.id };
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
  fallback ??= createJobsFacade(
    {
      // A getter, not a snapshot: `setJobDriver()` after the first enqueue is honoured, and a
      // missing driver is an error at the call rather than at import time.
      get driver(): JobDriver {
        const installed = jobDriver();
        if (installed === undefined) {
          throw new DriverUnavailableError({
            driver: 'none',
            cause: 'no queue driver is installed in this process',
            fix: 'call setJobDriver(createMemoryDriver()) before enqueuing, or setJobDriver(createPgDriver()) for a real queue',
          });
        }
        return installed;
      },
      // Unreachable while `currentTx` is `() => undefined`; present because `OutboxDeps`
      // requires a store, and a real one is cheaper than an assertion that cannot fire.
      store: createMemoryOutboxStore(),
    },
    () => undefined,
  );
  return fallback;
}

/** Test/CLI seam, the counterpart to `resetJobDriver()`: forget the installed facade. */
export function resetJobsFacade(): void {
  ambient = undefined;
}

export interface RelayOptions extends OutboxDeps {
  readonly batchSize?: number;
  readonly intervalMs?: number;
}

export interface OutboxRelay {
  /** One pass. Returns how many rows were published. Call it directly in tests. */
  tick(): Promise<number>;
  start(): void;
  /**
   * Stop polling and WAIT OUT the pass in flight, the way `worker.stop()` waits out its rounds and
   * `scheduler.stop()` its dispatch. A pass is a publish followed by a `markPublished`, and a
   * caller that returned between the two closed the database under the row it was about to mark:
   * re-published next boot at best, a rejection against a closed pool at worst.
   */
  stop(): Promise<void>;
  pending(): Promise<number>;
}

/**
 * At-least-once by construction: publish, THEN mark published. A crash between the two
 * re-publishes, which the idempotency key collapses — the opposite order would lose jobs.
 */
export function createOutboxRelay(options: RelayOptions): OutboxRelay {
  const batchSize = options.batchSize ?? 100;
  const intervalMs = options.intervalMs ?? 200;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  /** The pass in flight, so `stop()` joins it instead of returning underneath it. */
  let pass: Promise<void> | undefined;

  const tick = async (): Promise<number> => {
    const batch = await options.store.claim(batchSize);
    let published = 0;
    for (const record of batch) {
      try {
        await options.driver.enqueue({
          name: record.job,
          queue: record.queue,
          input: record.input,
          idempotencyKey: record.idempotencyKey,
          maxAttempts: record.maxAttempts,
          runAt: record.runAt,
          ...(record.tenantId === undefined ? {} : { tenantId: record.tenantId }),
          ...(record.traceparent === undefined ? {} : { traceparent: record.traceparent }),
          ...(record.enqueuedBy === undefined ? {} : { enqueuedBy: record.enqueuedBy }),
        });
        // The claim's own token goes back with the mark. Without it a relay whose lease lapsed
        // mid-stall retires a row the relay that reclaimed it has not published yet — the row is
        // gone and nothing publishes it.
        await options.store.markPublished(record.id, nowMs(options.clock), record.claimedBy);
        published += 1;
      } catch (error) {
        // STOP the batch. `claim()` returns rows in `staged_at` order and the loop used to log
        // and continue, which published every LATER row past the one that failed — so an app
        // that stages `createInvoice` then `chargeCard` in one transaction could have the charge
        // run first. The row stays unpublished and the next tick starts again from it; a
        // permanently poisoned row wedges its queue, which is visible in `pending()` and is the
        // correct trade against silently reordering committed work.
        logger.warn('jobs.outbox.publish-failed', {
          job: record.job,
          id: record.id,
          published,
          remaining: batch.length - published,
          error: error instanceof Error ? error.message : String(error),
        });
        // Hand the rest of the batch back rather than sit on a claim nobody is publishing. The
        // claim is a lease now, so without this a single pool timeout parks every committed row
        // behind it for the whole lease window instead of for one poll interval.
        await options.store.release?.(
          batch.slice(published).map((row) => row.id),
          record.claimedBy,
        );
        break;
      }
    }
    return published;
  };

  return {
    tick,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        // `.catch` before `.finally`, the shape every other loop in this package uses. `tick()`
        // guards each publish but not `store.claim()` — one pool timeout during a failover
        // rejects here unobserved, and Bun's default for an unhandled rejection is to end the
        // process, taking every staged, unpublished row with it.
        //
        // Kept rather than discarded, because `stop()` awaits exactly this chain: the publish and
        // the `markPublished` behind it are one pass, and a teardown that returned between them
        // closed the database under the row it was about to mark. The chain carries its own
        // `catch`, so a caller that does not await still gets no unhandled rejection.
        pass = tick()
          .then((): void => undefined)
          .catch((error: unknown) => {
            logger.error('jobs.outbox.tick-failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            running = false;
            pass = undefined;
          });
      }, intervalMs);
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      // Awaited AFTER the interval is cleared, so no further pass can start behind this one.
      await pass;
    },
    pending: () => options.store.pendingCount(),
  };
}

// The outbox's SQL moved to `driver-pg-sql.ts`, where every statement this package runs lives —
// and, more to the point, where `SQL_JOBS_TABLE` is: `x_outbox` was declared here, in a constant
// no boot code applied, which is the whole reason the outbox was documented and never created.
// `src/index.ts` still re-exports the same four names, from there.
