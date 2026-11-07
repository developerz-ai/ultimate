// Single responsibility: native push devices in Postgres — `x_push_devices`, a framework table
// applied by the boot (`@ultimat3/cli`'s `FRAMEWORK_SCHEMA`) the way `x_notify_inbox` is, never an
// `entity()` an app's `x db gen` would own. Statements are spelled out so the one in a log is the
// one to run.

import type { PgExecutor } from '@ultimat3/core';
import type { PushDeviceRecord, PushDeviceStore, PushPlatform } from './push-device';

/** The table. One name, read by this DDL and by the statements below. */
export const PUSH_DEVICES_TABLE = 'x_push_devices';

/**
 * Applied by the boot, never by an app migration; `if not exists` throughout, so every boot can.
 * `(platform, token)` is the key (`push-device.ts` says why). `actor_id` is indexed because the one
 * hot read is "every device of this person", once per notification sent.
 */
export const SQL_PUSH_DEVICES_TABLE = `
create table if not exists x_push_devices (
  platform   text        not null check (platform in ('ios', 'android')),
  token      text        not null,
  actor_id   text        not null,
  locale     text        not null,
  time_zone  text        not null,
  created_at timestamptz not null default now(),
  bad_tokens integer     not null default 0,
  primary key (platform, token)
);

alter table x_push_devices add column if not exists bad_tokens integer not null default 0;

create index if not exists x_push_devices_actor_idx on x_push_devices (actor_id);
`;

/** A re-register moves the token to this actor and its locale; `created_at` and `bad_tokens` stay. */
export const SQL_PUSH_DEVICE_SAVE = `
insert into x_push_devices (platform, token, actor_id, locale, time_zone, created_at)
values ($1, $2, $3, $4, $5, $6)
on conflict (platform, token) do update set
  actor_id = excluded.actor_id, locale = excluded.locale, time_zone = excluded.time_zone
`;

/** `collate "C"`: the memory store orders by code point, and one order is the contract. */
export const SQL_PUSH_DEVICE_LIST = `
select platform, token, actor_id, locale, time_zone, created_at, bad_tokens
from x_push_devices where actor_id = $1
order by platform collate "C", token collate "C"
`;

/** `$3` null deletes whoever holds it — the sender's dead token; an unregister names its owner. */
export const SQL_PUSH_DEVICE_REMOVE = `
delete from x_push_devices
where platform = $1 and token = $2 and ($3::text is null or actor_id = $3)
returning token
`;

/** One more bad-token answer; no row answers no count, which the sender reads as 0. */
export const SQL_PUSH_DEVICE_BAD_TOKEN = `
update x_push_devices set bad_tokens = bad_tokens + 1
where platform = $1 and token = $2
returning bad_tokens
`;

/** Only a row that has a count is written: a delivery to a healthy device costs no write. */
export const SQL_PUSH_DEVICE_BAD_TOKEN_CLEAR = `
update x_push_devices set bad_tokens = 0
where platform = $1 and token = $2 and bad_tokens > 0
`;

interface DeviceDbRow {
  readonly platform: PushPlatform;
  readonly token: string;
  readonly actor_id: string;
  readonly locale: string;
  readonly time_zone: string;
  readonly created_at: Date | string;
  readonly bad_tokens: number | string;
}

const fromRow = (row: DeviceDbRow): PushDeviceRecord => ({
  platform: row.platform,
  token: row.token,
  actorId: row.actor_id,
  locale: row.locale,
  timeZone: row.time_zone,
  createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).getTime(),
  // Absent at 0, as the memory store leaves it: one record shape from both.
  ...(Number(row.bad_tokens) > 0 ? { badTokens: Number(row.bad_tokens) } : {}),
});

export interface PostgresPushDeviceStoreOptions {
  /** `@ultimat3/db`'s `dbExecutor()` — `Bun.sql` does not satisfy it. */
  readonly executor: PgExecutor;
}

export function postgresPushDeviceStore(options: PostgresPushDeviceStoreOptions): PushDeviceStore {
  const { executor } = options;
  return {
    async save(record) {
      await executor.query(SQL_PUSH_DEVICE_SAVE, [
        record.platform,
        record.token,
        record.actorId,
        record.locale,
        record.timeZone,
        new Date(record.createdAt),
      ]);
    },
    async listFor(actorId) {
      return (await executor.query<DeviceDbRow>(SQL_PUSH_DEVICE_LIST, [actorId])).map(fromRow);
    },
    async remove(platform, token, actorId) {
      const rows = await executor.query(SQL_PUSH_DEVICE_REMOVE, [platform, token, actorId ?? null]);
      return rows.length > 0;
    },
    async noteBadToken(platform, token) {
      const rows = await executor.query<{ bad_tokens: number | string }>(
        SQL_PUSH_DEVICE_BAD_TOKEN,
        [platform, token],
      );
      return rows[0] === undefined ? 0 : Number(rows[0].bad_tokens);
    },
    async clearBadToken(platform, token) {
      await executor.query(SQL_PUSH_DEVICE_BAD_TOKEN_CLEAR, [platform, token]);
    },
  };
}
