// The durable audit log: one framework table, one insert per entry, read back by keyset. What
// `defineAdmin({ audit: postgresAuditLog() })` names — the memory log is a ring that forgets at
// every restart, and a row's history that ends at the last deploy is not a history.

import { isUltimateError, uuidV7 } from '@ultimat3/core';
import { type DbClient, db, withTransaction } from '@ultimat3/db';
import {
  AUDIT_READ_OPERATIONS,
  type AuditDraft,
  type AuditEntry,
  type AuditFieldDiff,
  type AuditLog,
  type AuditOutcome,
  type AuditQuery,
  type AuditSink,
  auditEntry,
  auditLimit,
  isAllowedRead,
} from './audit';
import { ADMIN_AUDIT_TABLE } from './audit-schema';
import { jsonText } from './json-text';

const SUBJECT = 'postgresAuditLog';

/** `recorded_at` is the database's clock and not a parameter: the gap to `at` is the audit lag. */
export const SQL_ADMIN_AUDIT_INSERT = `
insert into x_admin_audit (
  id, at, request_id, actor_id, actor_roles, org_id,
  operation, kind, entity, entity_id, permission, outcome, reason, diff
) values (
  $1::uuid, $2::timestamptz, $3, $4, $5::jsonb, $6,
  $7, $8, $9, $10, $11, $12, $13, $14::jsonb
)
`;

const COLUMNS =
  'id, at, request_id, actor_id, actor_roles, org_id, operation, kind, entity, entity_id, permission, outcome, reason, diff';

interface AuditRow {
  readonly id: string;
  readonly at: Date | string;
  readonly request_id: string;
  readonly actor_id: string;
  readonly actor_roles: unknown;
  readonly org_id: string | null;
  readonly operation: string;
  readonly kind: string;
  readonly entity: string;
  readonly entity_id: string | null;
  readonly permission: string;
  readonly outcome: string;
  readonly reason: string;
  readonly diff: unknown;
}

/** A `jsonb` column, whichever way the driver hands it back: parsed, or as its text. */
const parsed = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const OUTCOMES: readonly AuditOutcome[] = ['allowed', 'denied', 'failed'];

const entryOf = (row: AuditRow): AuditEntry => {
  const roles = parsed(row.actor_roles);
  const diff = parsed(row.diff);
  const outcome = OUTCOMES.find((known) => known === row.outcome) ?? 'failed';
  return {
    id: row.id,
    at: (row.at instanceof Date ? row.at : new Date(row.at)).toISOString(),
    requestId: row.request_id,
    actor: {
      id: row.actor_id,
      roles: Array.isArray(roles) ? roles.map(String) : [],
      ...(row.org_id === null ? {} : { orgId: row.org_id }),
    },
    operation: row.operation,
    kind: row.kind === 'action' ? 'action' : 'operation',
    entity: row.entity,
    entityId: row.entity_id,
    permission: row.permission,
    outcome,
    reason: row.reason,
    diff: Array.isArray(diff) ? (diff as readonly AuditFieldDiff[]) : [],
  };
};

/**
 * The `where` of one read, built from the predicates the query actually names — never
 * `($1 is null or entity = $1)`, which hides the index from the planner. Every fragment is fixed
 * text; only values are bound.
 */
function selectFor(query: AuditQuery, limit: number): { text: string; values: unknown[] } {
  const where: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${String(values.length)}`;
  };
  if (query.entity !== undefined) where.push(`entity = ${bind(query.entity)}`);
  if (query.entityId !== undefined) where.push(`entity_id = ${bind(query.entityId)}`);
  if (query.actorId !== undefined) where.push(`actor_id = ${bind(query.actorId)}`);
  if (query.orgId !== undefined) where.push(`org_id = ${bind(query.orgId)}`);
  if (query.before !== undefined) {
    where.push(
      `(at, id) < (${bind(query.before.at)}::timestamptz, ${bind(query.before.id)}::uuid)`,
    );
  }
  if (query.changes === true) {
    const reads = AUDIT_READ_OPERATIONS.map((operation) => bind(operation)).join(', ');
    where.push(`(kind = 'action' or outcome <> 'allowed' or operation not in (${reads}))`);
  }
  const filter = where.length === 0 ? '' : ` where ${where.join(' and ')}`;
  return {
    text: `select ${COLUMNS} from ${ADMIN_AUDIT_TABLE}${filter} order by at desc, id desc limit ${bind(limit)}`,
    values,
  };
}

export interface PostgresAuditLogOptions {
  /**
   * The database to write to. Omitted — the ordinary case — it is the process's own (`db()`), so
   * an entry joins whatever transaction is open and every role writes through the pool it booted.
   */
  readonly client?: DbClient;
  /**
   * Persist the reads that were allowed too — every list page, every row opened. Off by default:
   * that is one insert per GET, and a trail of who LOOKED is a decision an app makes. A refused
   * read is an event and is always written.
   */
  readonly reads?: boolean;
  readonly sinks?: readonly AuditSink[];
  readonly now?: () => Date;
  /** Must answer a uuid: the column is one. Omitted, a time-ordered v7. */
  readonly nextId?: () => string;
}

/**
 * The audit log an admin names to keep its trail: `defineAdmin({ audit: postgresAuditLog() })`.
 *
 * One `insert` per entry, and `atomic` puts a write and its entry in one transaction — so a row
 * never changes without the entry that says who changed it. A repository pinned to its own client
 * cannot join that transaction (`X_REPO_CLIENT_PINNED`, raised before its first statement is
 * sent): the write then runs as it would have with no log, and its entry follows it.
 */
export function postgresAuditLog(options: PostgresAuditLogOptions = {}): AuditLog {
  const now = options.now ?? ((): Date => new Date());
  const nextId = options.nextId ?? uuidV7;
  const sinks = options.sinks ?? [];
  const reads = options.reads === true;
  // Resolved per statement, never captured: inside `atomic` it is the open transaction.
  const client = (): DbClient => (options.client === undefined ? db() : options.client);

  return {
    kind: 'postgres',
    async append(draft: AuditDraft): Promise<AuditEntry> {
      const entry = auditEntry(draft, nextId(), now());
      if (reads || !isAllowedRead(entry)) {
        // A plain `{ text, values }`, the shape `pgExecutorFor` hands the same client: the text
        // is this file's constant and every value is bound.
        await client().query({
          text: SQL_ADMIN_AUDIT_INSERT,
          values: [
            entry.id,
            entry.at,
            entry.requestId,
            entry.actor.id,
            JSON.stringify(entry.actor.roles),
            entry.actor.orgId ?? null,
            entry.operation,
            entry.kind,
            entry.entity,
            entry.entityId,
            entry.permission,
            entry.outcome,
            entry.reason,
            // `jsonText`, not `JSON.stringify`: a `money()` diff holds a bigint, which the
            // second throws on — after the write it describes has already happened.
            jsonText(entry.diff),
          ],
        });
      }
      for (const sink of sinks) await sink.write(entry);
      return entry;
    },
    async entries(query = {}): Promise<readonly AuditEntry[]> {
      const select = selectFor(query, auditLimit(SUBJECT, query));
      const rows = await client().query<AuditRow>(select);
      return rows.map(entryOf);
    },
    async atomic<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await withTransaction(
          run,
          options.client === undefined ? {} : { client: options.client },
        );
      } catch (error) {
        if (isUltimateError(error) && error.code === 'X_REPO_CLIENT_PINNED') return run();
        throw error;
      }
    },
  };
}
