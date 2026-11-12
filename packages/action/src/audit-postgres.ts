/**
 * The durable audit sink: one append-only Postgres table, one row per record — an insert each, or
 * one per batch under `groupCommit`. Without it the shortest edit clearing `X_AUDIT_SINK_MISSING`
 * is `memoryAuditSink()`, a ring that DROPS. Statements are spelled out so an agent can run them.
 */

import type { PgExecutor } from '@ultimat3/core';
import type { AuditRecord } from './audit';
import type { BatchAuditSink, BatchedAuditSink, BatchedAuditSinkOptions } from './audit-batch';
import { batchedAuditSink } from './audit-batch';
import { rowOf } from './audit-postgres-row';

/**
 * Applied by the boot, never by an app migration — the rule `SQL_IDEMPOTENCY_TABLE` follows, and
 * for the same reason: this package holds no database dependency and cannot apply its own schema.
 * `create table if not exists` is a no-op against a database that already has it, so a new column
 * is added by `alter table … add column if not exists` and never by editing the `create`.
 *
 * **Two indexes and no third.** "Who did what, when" is the only question an audit table is opened
 * for, and an index is a write cost paid on the audited path. A SUBJECT index — which row the
 * action was about — is deliberately absent: the framework does not know a record's subject, and
 * guessing one is the audit ENTITY this seam refuses to ship.
 *
 * **`at` is the one nullable column that looks like it should not be.** It is `ctx.now()`, and a
 * `Clock` is injectable, so an app can hand this seam an Invalid Date — whose `toISOString()`
 * THROWS. A sink that raises fails an invocation whose handler has already committed, so an
 * unrepresentable instant is written as "this process could not say when" and `recorded_at`, the
 * database's own clock, still stamps the row. `not null` would have traded a lost row for a lost
 * write.
 *
 * **No retention, no purge, and that is the difference from every other table this framework
 * owns.** `x_idempotency` and `x_rate_limit` both ship a purge because a stale row there is
 * meaningless; a stale audit row is the record. How long a trail is kept is a legal question with
 * a different answer per app — seven years for one, thirty days for the next — so shipping a
 * `delete` would be shipping one of those answers. The table grows until the app prunes or
 * partitions it, and that is stated rather than solved.
 *
 * **`primitive` arrived by `alter`, with a default of `'action'`.** The sink is shared with
 * `query({ audit: true })` since plan 101 sweep 10b, so a row has to say whether a read or a write
 * acted; every row written before that was an action's, which is exactly what the default says.
 */
export const SQL_AUDIT_TABLE = `
create table if not exists x_audit (
  id                uuid        primary key,
  at                timestamptz,
  action            text        not null,
  mutator           boolean     not null,
  surface           text        not null,
  outcome           text        not null,
  replayed          boolean     not null,
  idempotency_key   text,
  failure_code      text,
  actor_id          text        not null,
  actor_kind        text        not null,
  org_id            text,
  on_behalf_of_id   text,
  on_behalf_of_kind text,
  request_id        text        not null,
  trace_id          text        not null,
  locale            text        not null,
  tz                text        not null,
  build_id          text        not null,
  role              text        not null,
  input             jsonb,
  recorded_at       timestamptz not null default now()
);

alter table x_audit add column if not exists primitive text not null default 'action';

create index if not exists x_audit_at_idx on x_audit (at desc);

create index if not exists x_audit_actor_at_idx on x_audit (actor_id, at desc);
`;

/**
 * `id` is generated per ROW and is not an idempotency key: two identical attempts are two events
 * and an audit trail that collapsed them would be lying about how many times something was tried.
 * There is deliberately no `on conflict` — an append-only table has nothing to reconcile.
 *
 * `recorded_at` defaults to `now()` and is not a parameter: `at` is the caller's clock
 * (`ctx.now()`) and this is the database's, so the gap between them is the audit lag, and a
 * process whose clock has drifted is visible instead of invisible.
 */
export const SQL_AUDIT_INSERT = `
insert into x_audit (
  id, at, action, mutator, surface, outcome, replayed, idempotency_key, failure_code,
  actor_id, actor_kind, org_id, on_behalf_of_id, on_behalf_of_kind,
  request_id, trace_id, locale, tz, build_id, role, input, primitive
) values (
  $1::uuid, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9,
  $10, $11, $12, $13, $14,
  $15, $16, $17, $18, $19, $20, $21::jsonb, $22
)
`;

/**
 * Group commit's statement: N rows in one round trip, as ONE `jsonb` parameter unpacked by
 * `jsonb_to_recordset`. Not `unnest($1::uuid[], …)`: `PgExecutor` is structural, and how a JS
 * array binds is the driver's business — a JSON text binds the same through every one of them.
 * `input` travels as the text `write` binds and is cast here, so a JSON `null` input stays the
 * jsonb `null` it is in a single-row insert and only an unparsed input is a SQL NULL.
 */
export const SQL_AUDIT_INSERT_MANY = `
insert into x_audit (
  id, at, action, mutator, surface, outcome, replayed, idempotency_key, failure_code,
  actor_id, actor_kind, org_id, on_behalf_of_id, on_behalf_of_kind,
  request_id, trace_id, locale, tz, build_id, role, input, primitive
)
select
  id, at, action, mutator, surface, outcome, replayed, idempotency_key, failure_code,
  actor_id, actor_kind, org_id, on_behalf_of_id, on_behalf_of_kind,
  request_id, trace_id, locale, tz, build_id, role, input::jsonb, primitive
from jsonb_to_recordset($1::jsonb) as r (
  id uuid, at timestamptz, action text, mutator boolean, surface text, outcome text,
  replayed boolean, idempotency_key text, failure_code text,
  actor_id text, actor_kind text, org_id text, on_behalf_of_id text, on_behalf_of_kind text,
  request_id text, trace_id text, locale text, tz text, build_id text, role text,
  input text, primitive text
)
`;

export interface PostgresAuditSinkOptions {
  readonly executor: PgExecutor;
  /**
   * Group commit: concurrent writes share one `SQL_AUDIT_INSERT_MANY`, and each `write()` still
   * settles with its own batch (`batchedAuditSink`). `true` takes the defaults; an object sets
   * `maxRecords` / `maxDelayMs`. Absent: one insert per record, as before.
   */
  readonly groupCommit?: boolean | BatchedAuditSinkOptions | undefined;
}

export interface PostgresAuditSink extends BatchAuditSink {
  write(record: AuditRecord): Promise<void>;
}

/**
 * **Name it in `apps/web/runtime.ts`, beside the rest of this app's durability**, over the pool the
 * boot opened — the boot installs it (`installAuditSink`) before the app's modules import:
 *
 * ```ts
 * export const runtime = {
 *   auditSink: postgresAuditSink({ executor: dbExecutor() }),
 * } satisfies RuntimeOverrides;
 * ```
 *
 * `Bun.sql` does not satisfy `PgExecutor` — `Bun.sql.query` is `undefined`; see that interface.
 *
 * What is written is an ALLOW-LIST of the facts the framework itself owns, never the `Ctx`. That
 * is not tidiness: `ctxOf` spreads every installed service onto the context object, and on
 * an HTTP surface the value is a `RequestContext` carrying the request's own `Authorization` and
 * `Cookie` headers — so a projection that walked it would write an app's database clients and its
 * caller's credentials into an audit table. An app that wants more columns writes its own
 * `AuditSink`; the seam is one method, and that is the extension point.
 *
 * `groupCommit` trades up to `maxDelayMs` of latency per audited call for one round trip per batch
 * instead of per call; the sink then flushes on drain, before the pool closes.
 */
export function postgresAuditSink(
  options: PostgresAuditSinkOptions & { readonly groupCommit: true | BatchedAuditSinkOptions },
): BatchedAuditSink;
export function postgresAuditSink(options: PostgresAuditSinkOptions): PostgresAuditSink;
export function postgresAuditSink(
  options: PostgresAuditSinkOptions,
): PostgresAuditSink | BatchedAuditSink {
  const exec = options.executor;
  const sink: PostgresAuditSink = {
    async write(record: AuditRecord): Promise<void> {
      await exec.query(SQL_AUDIT_INSERT, Object.values(rowOf(record)));
    },
    async writeMany(records: readonly AuditRecord[]): Promise<void> {
      if (records.length === 0) return;
      await exec.query(SQL_AUDIT_INSERT_MANY, [JSON.stringify(records.map(rowOf))]);
    },
  };
  const group = options.groupCommit;
  if (group === undefined || group === false) return sink;
  return batchedAuditSink(sink, group === true ? {} : group);
}
