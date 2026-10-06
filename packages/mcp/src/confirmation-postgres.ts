// The shared confirmation store: one Postgres table, the open row held unique by a partial index so
// two identical agent calls racing open ONE row, and every transition a single conditional UPDATE.
// Statements are spelled out so an operator can run the exact one a log line names.

import type { PgExecutor } from '@ultimat3/core';
import { McpConfirmationContestedError } from './confirmation-errors';
import type {
  McpConfirmation,
  McpConfirmationStatus,
  McpConfirmationStore,
} from './confirmation-store';

export const SQL_MCP_CONFIRMATION_OPEN = `
insert into x_mcp_confirmations
  (id, actor_id, org_id, tool, input_digest, sealed_arguments, created_at, expires_at)
values ($1, $2, $3, $4, $5, $6, $7, $8)
on conflict (actor_id, tool, input_digest) where consumed_at is null do nothing
returning *
`;

export const SQL_MCP_CONFIRMATION_OPEN_ROW = `
select * from x_mcp_confirmations
where actor_id = $1 and tool = $2 and input_digest = $3 and consumed_at is null
`;

export const SQL_MCP_CONFIRMATION_GET = 'select * from x_mcp_confirmations where id = $1';

export const SQL_MCP_CONFIRMATION_DECIDE = `
update x_mcp_confirmations set status = $2, decided_by = $3, decided_at = $4
where id = $1 and status = 'pending' and consumed_at is null and expires_at > $4
returning *
`;

export const SQL_MCP_CONFIRMATION_CONSUME = `
update x_mcp_confirmations set consumed_at = $2 where id = $1 and consumed_at is null returning id
`;

export const SQL_MCP_CONFIRMATION_PURGE = `
with purged as (delete from x_mcp_confirmations where expires_at < $1 returning 1)
select count(*)::int as purged from purged
`;

interface Row {
  readonly id: string;
  readonly actor_id: string;
  readonly org_id: string | null;
  readonly tool: string;
  readonly input_digest: string;
  readonly sealed_arguments: string;
  readonly status: string;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly decided_at: Date | string | null;
  readonly decided_by: string | null;
  readonly consumed_at: Date | string | null;
}

export interface PostgresConfirmationStoreOptions {
  /**
   * A real `PgExecutor` over the process's client — read on every call, so a declaration evaluated
   * before the boot opened the pool still reaches it: `{ query: (text, values) => db().query(…) }`.
   */
  readonly executor: PgExecutor;
}

export function postgresConfirmationStore(
  options: PostgresConfirmationStoreOptions,
): McpConfirmationStore {
  const exec = options.executor;
  const first = async (sql: string, params: readonly unknown[]) => {
    const row = (await exec.query<Row>(sql, params))[0];
    return row === undefined ? undefined : toConfirmation(row);
  };
  return {
    async open(draft) {
      // Bounded: the insert and the read can both come back empty only when a concurrent consume
      // freed the key between them, and the next insert then wins it.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const created = await first(SQL_MCP_CONFIRMATION_OPEN, [
          draft.id,
          draft.actorId,
          draft.orgId,
          draft.tool,
          draft.inputDigest,
          draft.sealedArguments,
          draft.createdAt,
          draft.expiresAt,
        ]);
        if (created !== undefined) return { row: created, created: true };
        const held = await first(SQL_MCP_CONFIRMATION_OPEN_ROW, [
          draft.actorId,
          draft.tool,
          draft.inputDigest,
        ]);
        if (held !== undefined) return { row: held, created: false };
      }
      // Never reported as created: the caller would tell the agent a row exists that does not.
      throw new McpConfirmationContestedError(draft.tool);
    },
    get: (id) => first(SQL_MCP_CONFIRMATION_GET, [id]),
    decide: (id, status, by, at) => first(SQL_MCP_CONFIRMATION_DECIDE, [id, status, by, at]),
    async consume(id, at) {
      return (await exec.query(SQL_MCP_CONFIRMATION_CONSUME, [id, at])).length === 1;
    },
    async purge(before) {
      const rows = await exec.query<{ purged: number | string }>(SQL_MCP_CONFIRMATION_PURGE, [
        before,
      ]);
      return Number(rows[0]?.purged ?? 0);
    },
  };
}

const STATUSES: ReadonlySet<string> = new Set<McpConfirmationStatus>([
  'pending',
  'approved',
  'rejected',
]);

/** Every Postgres client answers `timestamptz` as a `Date` or an ISO string; both read the same. */
const dateOf = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const maybeDate = (value: Date | string | null): Date | null =>
  value === null ? null : dateOf(value);

function toConfirmation(row: Row): McpConfirmation {
  // A status this file never writes is a row someone edited by hand: read as `rejected`, the one
  // reading that can neither run the call nor be decided again.
  const status = STATUSES.has(row.status) ? (row.status as McpConfirmationStatus) : 'rejected';
  return {
    id: row.id,
    actorId: row.actor_id,
    orgId: row.org_id,
    tool: row.tool,
    inputDigest: row.input_digest,
    sealedArguments: row.sealed_arguments,
    status,
    createdAt: dateOf(row.created_at),
    expiresAt: dateOf(row.expires_at),
    decidedAt: maybeDate(row.decided_at),
    decidedBy: row.decided_by,
    consumedAt: maybeDate(row.consumed_at),
  };
}
