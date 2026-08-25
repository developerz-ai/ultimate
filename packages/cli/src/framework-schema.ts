// The framework's OWN tables, as one table: which package declares each, which relations it
// creates, and the DDL. One list, read by the one applier, so "installed in dev and not in
// production" is not a state this framework can be in — `startQueue` is on every boot path there
// is, `ROLE=migrate` included.
//
// A framework table an app has to install by hand is a table that will be missing in production on
// the one code path that needs it, and it surfaces as a Postgres `42P01` from inside a worker.

import { SQL_AUDIT_TABLE, SQL_IDEMPOTENCY_TABLE } from '@ultimat3/action';
import { AUTH_TABLE_NAMES, AUTH_TABLES, SQL_AUTH_LIMIT_TABLES } from '@ultimat3/auth';
import { SQL_RATE_LIMIT_TABLE } from '@ultimat3/http';
import { SQL_JOBS_TABLE } from '@ultimat3/jobs';
import { SQL_NOTIFY_DELIVERIES_TABLE, SQL_NOTIFY_INBOX_TABLE } from '@ultimat3/notify';
import { FrameworkSchemaFailedError } from './schema-errors';

export interface FrameworkSchema {
  /** The package whose source declares the DDL — where to look when a column is wrong. */
  readonly pkg: string;
  /**
   * Every relation this entry creates. Read by the refusal below, so an operator learns which
   * tables were being installed rather than only which statement failed — and pinned against the
   * DDL text by `framework-schema.test.ts`, so a row cannot claim a table its SQL never creates.
   */
  readonly tables: readonly string[];
  /** One or more statements each; `;` separates. */
  readonly ddl: readonly string[];
}

/**
 * Applied unconditionally, whether or not this boot installs a store behind it.
 *
 * `create table if not exists` on an unused table costs one round trip at boot. The alternative
 * costs a request: a store installed later must never be the thing that discovers the schema was
 * never applied, and several of these are installed AFTER this runs — `defineAuth` builds its
 * limiter when the app's modules import, and `setNotifyStores` is an app's boot line.
 *
 * Ordered so a foreign key never precedes its target. Only `AUTH_TABLES` has any, and they are
 * internal to that entry, which is why it ships as an ordered list rather than one string.
 */
export const FRAMEWORK_SCHEMA: readonly FrameworkSchema[] = Object.freeze([
  Object.freeze({
    pkg: '@ultimat3/jobs',
    tables: Object.freeze([
      'x_jobs',
      'x_job_steps',
      'x_backfills',
      'x_outbox',
      'x_scheduler_state',
      'x_scheduler_leader',
      'x_job_leases',
      'x_job_events',
    ]),
    ddl: Object.freeze([SQL_JOBS_TABLE]),
  }),
  Object.freeze({
    pkg: '@ultimat3/action',
    tables: Object.freeze(['x_idempotency']),
    ddl: Object.freeze([SQL_IDEMPOTENCY_TABLE]),
  }),
  // The DDL only, and deliberately NO `setAuditSink`: there is no default audit sink on purpose,
  // so `X_AUDIT_SINK_MISSING` keeps firing at boot for an app that declares `audit: true` and
  // installs none.
  Object.freeze({
    pkg: '@ultimat3/action',
    tables: Object.freeze(['x_audit']),
    ddl: Object.freeze([SQL_AUDIT_TABLE]),
  }),
  Object.freeze({
    pkg: '@ultimat3/http',
    tables: Object.freeze(['x_rate_limit']),
    ddl: Object.freeze([SQL_RATE_LIMIT_TABLE]),
  }),
  Object.freeze({
    pkg: '@ultimat3/auth',
    tables: Object.freeze(['x_auth_failures', 'x_auth_lockouts']),
    ddl: Object.freeze([SQL_AUTH_LIMIT_TABLES]),
  }),
  /**
   * The five tables `BuiltinAdapter` reads, and the oldest hole in this list.
   *
   * `packages/auth/src/tables.ts` exports them "so an app can paste them into a migration", and
   * nothing in the framework has ever applied them — while `x db gen` diffs `describeEntities()`
   * and these are not `entity()` declarations, so neither half was a file anybody could
   * hand-write. `examples/dummy/CLAUDE.md` records the consequence in its own words: nobody can
   * hold a session in the reference app. Applied here on exactly the rule the rate-limit and audit
   * rows already follow.
   *
   * `AUTH_TABLE_NAMES` rather than five literals: @ultimat3/auth already publishes the list, and a
   * second copy is a second thing to keep right when a table is added.
   */
  Object.freeze({
    pkg: '@ultimat3/auth',
    tables: AUTH_TABLE_NAMES,
    ddl: AUTH_TABLES,
  }),
  /**
   * The delivery ledger is what stops a replayed notifier job sending twice, and it is the entry
   * whose absence is least visible: without the table the ledger's first `claim` raises `42P01`
   * from inside a worker, which reads as a dead-lettered notification rather than as a missing
   * schema. Installed whether or not this boot calls `setNotifyStores`, for the same reason as
   * every row above it — that call is an APP's boot line and runs after this one.
   */
  Object.freeze({
    pkg: '@ultimat3/notify',
    tables: Object.freeze(['x_notify_deliveries']),
    ddl: Object.freeze([SQL_NOTIFY_DELIVERIES_TABLE]),
  }),
  Object.freeze({
    pkg: '@ultimat3/notify',
    tables: Object.freeze(['x_notify_inbox']),
    ddl: Object.freeze([SQL_NOTIFY_INBOX_TABLE]),
  }),
]);

/** Every relation this boot creates, flattened. */
export const frameworkTableNames = (): readonly string[] =>
  FRAMEWORK_SCHEMA.flatMap((entry) => [...entry.tables]);

/**
 * PGlite speaks the extended protocol, which carries one statement per round trip, so the DDL is
 * applied statement by statement. Safe to split on `;`: every constant is fixed, with no semicolon
 * inside a literal, and each package's own SQL test is where that stays true.
 */
export const schemaStatements = (ddl: readonly string[]): readonly string[] =>
  ddl.flatMap((text) => text.split(';')).filter((statement) => statement.trim().length > 0);

/** One statement, executed. The caller owns the connection; this file owns no database import. */
export type SchemaExecutor = (statement: string) => Promise<unknown>;

/**
 * Apply every entry, in order, and answer what was created.
 *
 * The refusal is the point of the `pkg`/`tables` columns: a raw `permission denied for schema
 * public` names neither the framework table it was creating nor the package that wants it, and a
 * boot failure is read by an operator who has no source tree open.
 */
export async function applyFrameworkSchema(execute: SchemaExecutor): Promise<readonly string[]> {
  for (const entry of FRAMEWORK_SCHEMA) {
    for (const statement of schemaStatements(entry.ddl)) {
      try {
        await execute(statement);
      } catch (error) {
        throw new FrameworkSchemaFailedError({
          pkg: entry.pkg,
          tables: entry.tables,
          cause: error,
        });
      }
    }
  }
  return frameworkTableNames();
}
