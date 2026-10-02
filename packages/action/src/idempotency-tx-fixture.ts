// What the transactional idempotency suites share: a store, a business table the handler writes
// inside a transaction, and the one way a test makes a record old. Not a test file — the parity
// suite (memory and embedded Postgres) and the live one both drive it, through the same cases.

import type { DbClient } from '@ultimat3/db';
import { raw, sql, withTransaction } from '@ultimat3/db';
import type { IdempotencyStore } from './idempotency';
import { withIdempotency } from './idempotency';
import { MemoryIdempotencyStore } from './idempotency-memory';
import type { PgExecutor } from './idempotency-postgres';
import { postgresIdempotencyStore, SQL_IDEMPOTENCY_TABLE } from './idempotency-postgres';

/** The deadline every suite reclaims after. */
export const RECLAIM_MS = 30_000;

export interface ChargeHooks {
  readonly during?: () => Promise<void>;
  readonly after?: () => Promise<void>;
}

export interface TxHarness {
  readonly store: IdempotencyStore;
  /**
   * One charge, inside a transaction, behind the gate. `during` runs in the handler — after the
   * reservation, before the settle — and `after` in the same transaction once the gate returned.
   */
  charge(key: string, id: string, hooks?: ChargeHooks): Promise<unknown>;
  /** The same charge with no transaction around it — every statement its own commit. */
  chargeAutocommit(key: string, id: string): Promise<unknown>;
  charges(): Promise<readonly string[]>;
  statusOf(key: string): Promise<string | undefined>;
  /** Make every record `ms` older, as the store's own clock sees it. */
  age(key: string, ms: number): Promise<void>;
  reset(): Promise<void>;
}

/** What differs between the stores: the store, how its records age, how they are cleared. */
interface StoreUnderTest {
  readonly store: IdempotencyStore;
  age(key: string, ms: number): Promise<void>;
  reset(): Promise<void>;
}

export const executorFor = (client: DbClient): PgExecutor => ({
  query: <R>(text: string, values: readonly unknown[]) => client.query<R>({ text, values }),
});

/** The shared Postgres store over `client`, its DDL applied. Aged by the database's clock. */
export async function postgresUnderTest(client: DbClient): Promise<StoreUnderTest> {
  for (const statement of SQL_IDEMPOTENCY_TABLE.split(';')) {
    if (statement.trim().length > 0) await client.execute(raw(statement));
  }
  return {
    store: postgresIdempotencyStore({
      executor: executorFor(client),
      origin: () => client,
      reclaimAfterMs: () => RECLAIM_MS,
    }),
    age: async (key, ms) => {
      await client.execute(
        sql`update x_idempotency set created_at = created_at - (${ms}::bigint * interval '1 millisecond') where key = ${key}`,
      );
    },
    reset: async () => {
      await client.execute(raw('delete from x_idempotency'));
    },
  };
}

/** The process default. Aged by moving its injected clock forward. */
export function memoryUnderTest(): StoreUnderTest {
  let nowMs = 1_700_000_000_000;
  let store = new MemoryIdempotencyStore({ now: () => nowMs, reclaimAfterMs: () => RECLAIM_MS });
  return {
    get store() {
      return store;
    },
    age: (_key, ms) => {
      nowMs += ms;
      return Promise.resolve();
    },
    reset: () => {
      store = new MemoryIdempotencyStore({ now: () => nowMs, reclaimAfterMs: () => RECLAIM_MS });
      return Promise.resolve();
    },
  };
}

/** The harness: `under`'s store in front of a `tx_charges` table on `client`. */
export async function txHarness(client: DbClient, under: StoreUnderTest): Promise<TxHarness> {
  await client.execute(raw('create table if not exists tx_charges (id text primary key)'));
  // `db()`-style: a savepoint in the open transaction when there is one, a transaction otherwise.
  const insert = (id: string): Promise<unknown> =>
    withTransaction((tx) => tx.execute(sql`insert into tx_charges (id) values (${id})`), {
      client,
    });
  const run = (key: string, id: string, during?: () => Promise<void>) =>
    withIdempotency(under.store, key, { id: 'same-payload' }, async () => {
      await insert(id);
      await during?.();
      return { charged: id };
    });

  return {
    get store() {
      return under.store;
    },
    charge: (key, id, hooks) =>
      withTransaction(
        async () => {
          const outcome = await run(key, id, hooks?.during);
          await hooks?.after?.();
          return outcome;
        },
        { client },
      ),
    chargeAutocommit: (key, id) => run(key, id),
    charges: async () =>
      (await client.query<{ id: string }>(raw('select id from tx_charges order by id'))).map(
        (row) => row.id,
      ),
    statusOf: async (key) => (await under.store.get(key))?.status,
    age: (key, ms) => under.age(key, ms),
    reset: async () => {
      await client.execute(raw('delete from tx_charges'));
      await under.reset();
    },
  };
}
