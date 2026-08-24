/**
 * The durable audit sink: one append-only Postgres table, one insert per record. Without it the
 * shortest edit that clears `X_AUDIT_SINK_MISSING` is `setAuditSink(memoryAuditSink())`, which
 * reads durable at the call site and is a ring that DROPS — compliant in dev, amnesiac in
 * production. Statements are spelled out so an agent can run the exact one it saw in a log.
 */

import type { Actor } from '@ultimat3/core';
import { uuid } from '@ultimat3/core';
import type { AuditRecord, AuditSink } from './audit';
import { auditableInput } from './audit-input';
import type { PgExecutor } from './idempotency-postgres';

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
  request_id, trace_id, locale, tz, build_id, role, input
) values (
  $1::uuid, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9,
  $10, $11, $12, $13, $14,
  $15, $16, $17, $18, $19, $20, $21::jsonb
)
`;

export interface PostgresAuditSinkOptions {
  readonly executor: PgExecutor;
}

export interface PostgresAuditSink extends AuditSink {
  write(record: AuditRecord): Promise<void>;
}

/**
 * **Install it at boot, beside the store that declares the rest of this app's durability.** The
 * app owes one line in `apps/web/server.ts`, over the client this process already opened:
 *
 * ```ts
 * const client = db();
 * setAuditSink(
 *   postgresAuditSink({
 *     executor: { query: (text, values) => client.query({ text, values }) },
 *   }),
 * );
 * ```
 *
 * `Bun.sql` does not satisfy `PgExecutor` — `Bun.sql.query` is `undefined`; see that interface.
 *
 * What is written is an ALLOW-LIST of the facts the framework itself owns, never the `Ctx`. That
 * is not tidiness: `createContext` spreads every installed service onto the context object, and on
 * an HTTP surface the value is a `RequestContext` carrying the request's own `Authorization` and
 * `Cookie` headers — so a projection that walked it would write an app's database clients and its
 * caller's credentials into an audit table. An app that wants more columns writes its own
 * `AuditSink`; the seam is one method, and that is the extension point.
 */
export function postgresAuditSink(options: PostgresAuditSinkOptions): PostgresAuditSink {
  const exec = options.executor;
  return {
    async write(record: AuditRecord): Promise<void> {
      const actor = record.ctx.actor;
      const at = record.at instanceof Date && !Number.isNaN(record.at.getTime()) ? record.at : null;
      const onBehalfOf = onBehalfOfOf(actor);
      const input = auditableInput(record.input);
      await exec.query(SQL_AUDIT_INSERT, [
        uuid(),
        at === null ? null : at.toISOString(),
        record.action,
        record.mutator,
        record.surface,
        record.outcome,
        record.replayed,
        record.idempotencyKey,
        record.failure?.code ?? null,
        actor.id,
        actor.kind,
        actor.orgId ?? null,
        onBehalfOf?.actorId ?? null,
        onBehalfOf?.actorKind ?? null,
        record.ctx.requestId,
        record.ctx.traceId,
        record.ctx.locale,
        record.ctx.tz,
        record.ctx.buildId,
        record.ctx.role,
        // `undefined` in means a parse that never produced an input, which is a NULL column and
        // not the four characters `JSON.stringify(undefined)` does not produce either.
        input === undefined ? null : JSON.stringify(input),
      ]);
    },
  };
}

/**
 * Both halves of an impersonation, recorded and interpreted as NEITHER. `actor_id` is who the
 * framework ran the attempt as and `on_behalf_of_*` is what `impersonate()` recorded; which of
 * them an app calls "who did this" is the convention four apps model four ways, so the row carries
 * the two facts and takes no position between them.
 *
 * Read through a guard rather than off the type: `Actor.onBehalfOf` is optional, and an actor
 * minted by an app's own `resolveToken` is a plain object nothing in this package validated.
 */
function onBehalfOfOf(actor: Actor): { actorId: string; actorKind: string } | null {
  const origin: unknown = actor.onBehalfOf;
  if (typeof origin !== 'object' || origin === null) return null;
  const record = origin as Record<string, unknown>;
  const actorId = record['actorId'];
  const actorKind = record['actorKind'];
  if (typeof actorId !== 'string' || typeof actorKind !== 'string') return null;
  return { actorId, actorKind };
}
