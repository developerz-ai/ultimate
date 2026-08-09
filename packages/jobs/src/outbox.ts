// The transactional outbox — ON BY DEFAULT, because the alternative is a bug you cannot see
// in review. `ctx.jobs.enqueue()` inside a request writes the job row in the SAME `tx` as the
// business rows and a relay publishes it after commit. Without it, every enqueue is a
// distributed-transaction coin flip:
//
//   enqueue then rollback  -> the job runs against rows that never existed
//   commit then enqueue    -> the process dies in between and the job is lost forever
//
// Both are load-dependent, both pass every test, and both are the top source of "the email
// went out but the order isn't in the database" tickets. Joining the transaction removes the
// window entirely; the relay's at-least-once delivery is deduped by the job's idempotencyKey.

import type { Clock } from '@ultimat3/core';
import { logger, uuid } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import { nowMs } from './clock';
import type { EnqueueResult, JobDriver } from './driver';
import { DEFAULT_QUEUE, jobDriver } from './driver';
import { DriverUnavailableError, OutboxNoTxError } from './errors';
import type { JobHandle } from './job';

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
  readonly publishedAt?: number;
}

export interface OutboxStore {
  /** Write inside `tx`. Nothing is visible to the relay until that tx commits. */
  stage(tx: Tx, record: OutboxRecord): Promise<void>;
  /** Called by the tx runner after COMMIT. */
  commit(tx: Tx): Promise<readonly OutboxRecord[]>;
  /** Called by the tx runner after ROLLBACK. Staged rows vanish with the transaction. */
  rollback(tx: Tx): Promise<void>;
  /** Unpublished, committed rows — the relay's work queue. */
  claim(limit: number): Promise<readonly OutboxRecord[]>;
  markPublished(id: string, at: number): Promise<void>;
  pendingCount(): Promise<number>;
}

/**
 * Default store. Staged rows hang off the `Tx` object itself in a WeakMap, so the "same
 * transaction" guarantee needs no cooperation from the DB layer and rollback is a delete.
 * The pg store swaps this for a real `x_outbox` table written by the same connection.
 */
export function createMemoryOutboxStore(): OutboxStore {
  const staged = new WeakMap<object, OutboxRecord[]>();
  const committed = new Map<string, OutboxRecord>();

  const key = (tx: Tx): object => tx as unknown as object;

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
    claim(limit) {
      const ready = [...committed.values()]
        .filter((record) => record.publishedAt === undefined)
        .sort((a, b) => a.stagedAt - b.stagedAt)
        .slice(0, limit);
      return Promise.resolve(ready);
    },
    markPublished(id, at) {
      const record = committed.get(id);
      if (record !== undefined) committed.set(id, { ...record, publishedAt: at });
      return Promise.resolve();
    },
    pendingCount() {
      let count = 0;
      for (const record of committed.values()) {
        if (record.publishedAt === undefined) count += 1;
      }
      return Promise.resolve(count);
    },
  };
}

export interface EnqueueOptions {
  /** Epoch ms, or a delay via `runAt: nowMs() + toMs('5m')`. */
  readonly runAt?: number;
  readonly tenantId?: string;
  readonly queue?: string;
  /** Escape hatch for enqueues that must fire regardless of the caller's transaction. */
  readonly outbox?: boolean;
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
        return deps.driver.enqueue({
          name: handle.name,
          queue: options.queue ?? handle.queue,
          input,
          idempotencyKey: handle.idempotencyKeyFor(input),
          maxAttempts: handle.retry.attempts,
          runAt: options.runAt ?? nowMs(deps.clock),
          ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
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
            fix: 'call setJobDriver(createMemoryDriver()) before enqueuing — or set jobs.driver in app.config.ts and run `x dev`',
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
  stop(): void;
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
        });
        await options.store.markPublished(record.id, nowMs(options.clock));
        published += 1;
      } catch (error) {
        // Leave the row unpublished; the next tick retries it. Order is preserved per queue.
        logger.warn('jobs.outbox.publish-failed', {
          job: record.job,
          id: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
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
        void tick().finally(() => {
          running = false;
        });
      }, intervalMs);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    pending: () => options.store.pendingCount(),
  };
}

/** SQL for the pg-backed outbox. The relay publishes rows this INSERT created. */
export const SQL_OUTBOX_TABLE = `
create table if not exists x_outbox (
  id              uuid primary key,
  job             text        not null,
  queue           text        not null default 'default',
  input           jsonb       not null,
  idempotency_key text        not null,
  max_attempts    int         not null default 3,
  run_at          timestamptz not null default now(),
  staged_at       timestamptz not null default now(),
  tenant_id       text,
  published_at    timestamptz
);
create index if not exists x_outbox_unpublished_idx
  on x_outbox (staged_at) where published_at is null;
`.trim();

export const SQL_OUTBOX_STAGE = `
insert into x_outbox
  (id, job, queue, input, idempotency_key, max_attempts, run_at, staged_at, tenant_id)
values ($1, $2, $3, $4::jsonb, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), $9)
`.trim();

export const SQL_OUTBOX_CLAIM = `
select id, job, queue, input, idempotency_key, max_attempts,
       (extract(epoch from run_at) * 1000)::bigint    as run_at,
       (extract(epoch from staged_at) * 1000)::bigint as staged_at,
       tenant_id
  from x_outbox
 where published_at is null
 order by staged_at
 limit $1
   for update skip locked
`.trim();

export const SQL_OUTBOX_MARK_PUBLISHED = `
update x_outbox set published_at = to_timestamp($2 / 1000.0) where id = $1
`.trim();
