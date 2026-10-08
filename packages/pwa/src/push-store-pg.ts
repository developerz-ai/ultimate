// Single responsibility: push subscriptions in Postgres — `x_push_subscriptions`, a framework table
// applied by the boot (`@ultimat3/cli`'s `FRAMEWORK_SCHEMA`) the way `x_jobs` and `x_notify_inbox`
// are, never an `entity()` an app's `x db gen` would own. Statements are spelled out so the one in
// a log is the one to run.

import type { PgExecutor } from '@ultimat3/core';
import type { PushSubscriptionRecord } from './push';
import type { PushSubscriptionStore } from './push-store';

/** A re-subscribe moves the endpoint to this actor and its new keys; `created_at` stays first. */
const SQL_PUSH_SAVE = `
insert into x_push_subscriptions
  (endpoint, actor_id, p256dh, auth, locale, time_zone, expiration_time, created_at)
values ($1, $2, $3, $4, $5, $6, $7, $8)
on conflict (endpoint) do update set
  actor_id = excluded.actor_id, p256dh = excluded.p256dh, auth = excluded.auth,
  locale = excluded.locale, time_zone = excluded.time_zone,
  expiration_time = excluded.expiration_time
`;

/** `collate "C"`: the memory store orders by code point, and one order is the contract. */
const SQL_PUSH_LIST = `
select endpoint, actor_id, p256dh, auth, locale, time_zone, expiration_time, created_at
from x_push_subscriptions where actor_id = $1 order by endpoint collate "C"
`;

/** `$2` null deletes whoever holds it — the sender's 404/410; an unsubscribe names its owner. */
const SQL_PUSH_REMOVE = `
delete from x_push_subscriptions
where endpoint = $1 and ($2::text is null or actor_id = $2)
returning endpoint
`;

interface PushDbRow {
  readonly endpoint: string;
  readonly actor_id: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly locale: string;
  readonly time_zone: string;
  readonly expiration_time: number | string | null;
  readonly created_at: Date | string;
}

const fromRow = (row: PushDbRow): PushSubscriptionRecord => ({
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
  locale: row.locale,
  timeZone: row.time_zone,
  actorId: row.actor_id,
  // `bigint` arrives as a string from some drivers; it is epoch milliseconds either way.
  expirationTime: row.expiration_time === null ? null : Number(row.expiration_time),
  createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).getTime(),
});

export interface PostgresPushSubscriptionStoreOptions {
  /** `@ultimat3/db`'s `dbExecutor()` — `Bun.sql` does not satisfy it. */
  readonly executor: PgExecutor;
}

export function postgresPushSubscriptionStore(
  options: PostgresPushSubscriptionStoreOptions,
): PushSubscriptionStore {
  const { executor } = options;
  return {
    async save(record) {
      await executor.query(SQL_PUSH_SAVE, [
        record.endpoint,
        record.actorId,
        record.keys.p256dh,
        record.keys.auth,
        record.locale,
        record.timeZone,
        record.expirationTime,
        new Date(record.createdAt),
      ]);
    },
    async listFor(actorId) {
      return (await executor.query<PushDbRow>(SQL_PUSH_LIST, [actorId])).map(fromRow);
    },
    async remove(endpoint, actorId) {
      const rows = await executor.query(SQL_PUSH_REMOVE, [endpoint, actorId ?? null]);
      return rows.length > 0;
    },
  };
}
