// The DDL of Web Push's one framework table, and nothing else: a LEAF module, so the boot's
// `FRAMEWORK_SCHEMA` (`@ultimat3/cli`) applies it in every role through `@ultimat3/pwa/schema`
// without pulling the service-worker generator, the sender or `@ultimat3/action` into a worker's
// or a migrate pod's module graph — `@ultimat3/mcp/schema`'s shape. Imports nothing, by design.

/** The table. One name, read by this DDL and by `push-store-pg.ts`'s statements. */
export const PUSH_SUBSCRIPTIONS_TABLE = 'x_push_subscriptions';

/**
 * Applied by the boot, never by an app migration; `if not exists` throughout, so every boot can.
 * `endpoint` is the key (`push-store.ts` says why). `actor_id` is indexed because the one hot read
 * is "every device of this person", once per notification sent.
 */
export const SQL_PUSH_SUBSCRIPTIONS_TABLE = `
create table if not exists x_push_subscriptions (
  endpoint        text        primary key,
  actor_id        text        not null,
  p256dh          text        not null,
  auth            text        not null,
  locale          text        not null,
  time_zone       text        not null,
  expiration_time bigint,
  created_at      timestamptz not null default now()
);

create index if not exists x_push_subscriptions_actor_idx on x_push_subscriptions (actor_id);
`;
