// The world `idempotencyStoreConformance`'s transactional checks run in: one key behind
// `withIdempotency`, a handler writing one row of the caller's own table inside a real transaction
// on the subject's database. Not a suite — `idempotency-store-tx-conformance.ts` and
// `idempotency-store-replay-conformance.ts` drive it.

import { withIdempotency } from '@ultimat3/action';
import type { IdempotencyStore } from '@ultimat3/action/adapter';
import type { DbClient } from '@ultimat3/db';
import { raw, sql, withTransaction } from '@ultimat3/db';

/** `IdempotencyStoreSubject`, as the checks need it — restated to keep the imports one-way. */
export interface IdempotencyWorldSubject {
  readonly store: IdempotencyStore;
  readonly client: DbClient;
  readonly reclaimAfterMs: number;
  age(key: string, ms: number): Promise<void>;
}

export interface IdempotencyWorldCheck {
  readonly name: string;
  run(subject: IdempotencyWorldSubject): Promise<void>;
}

/** The caller's own table: the write the settle must commit with, or not at all. */
const CHARGES = 'x_conformance_charges';
export const DAY_MS = 24 * 60 * 60 * 1000;

let minted = 0;
const keyOf = (): string => {
  minted += 1;
  return `["conformance-tx","${process.pid.toString(36)}",${minted}]`;
};

/** The outer unit of work failing after the gate returned — the settle already ran. */
export const late = (): Promise<void> =>
  Promise.reject(new RangeError('the unit of work failed late'));
export const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

interface Hooks {
  readonly during?: () => Promise<void>;
  readonly after?: () => Promise<void>;
}

/** One key's world: a charge behind the gate, with or without a transaction around it. */
export async function world(subject: IdempotencyWorldSubject) {
  const { client, store } = subject;
  await client.execute(raw(`create table if not exists ${CHARGES} (key text, id text)`));
  const key = keyOf();
  const run = (id: string, during?: () => Promise<void>) =>
    withIdempotency(store, key, { id: 'same-payload' }, async () => {
      await withTransaction(
        (tx) => tx.execute(sql`insert into x_conformance_charges (key, id) values (${key}, ${id})`),
        { client },
      );
      await during?.();
      return { charged: id };
    });
  return {
    key,
    charge: (id: string, hooks: Hooks = {}) =>
      withTransaction(
        async () => {
          const outcome = await run(id, hooks.during);
          await hooks.after?.();
          return outcome;
        },
        { client },
      ),
    chargeAutocommit: (id: string) => run(id),
    charges: async () =>
      (
        await client.query<{ id: string }>(
          sql`select id from x_conformance_charges where key = ${key} order by id`,
        )
      ).map((row) => row.id),
    statusOf: async () => (await store.get(key))?.status,
    age: (ms: number) => subject.age(key, ms),
    once: (value: unknown) =>
      withIdempotency(store, key, { id: 'same-payload' }, () => Promise.resolve(value)),
  };
}
