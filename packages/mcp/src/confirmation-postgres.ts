// The shared confirmation store: one Postgres table, the open row held unique by a partial index so
// two identical agent calls racing open ONE row, and every transition a single conditional UPDATE.
// Statements are spelled out so an operator can run the exact one a log line names.

import type { PgExecutor } from '@ultimat3/core';
import { McpConfirmationContestedError } from './confirmation-errors';
import type {
  McpConfirmation,
  McpConfirmationApproval,
  McpConfirmationStatus,
  McpConfirmationStore,
} from './confirmation-store';

export const SQL_MCP_CONFIRMATION_OPEN = `
insert into x_mcp_confirmations
  (id, actor_id, org_id, tool, input_digest, sealed_arguments, created_at, expires_at, quorum,
   approvers)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
on conflict (actor_id, coalesce(org_id, ''), (org_id is null), tool, input_digest)
  where consumed_at is null do nothing
returning *
`;

export const SQL_MCP_CONFIRMATION_OPEN_ROW = `
select * from x_mcp_confirmations
where actor_id = $1 and org_id is not distinct from $2 and tool = $3 and input_digest = $4
  and consumed_at is null
`;

export const SQL_MCP_CONFIRMATION_GET = 'select * from x_mcp_confirmations where id = $1';

/**
 * One statement for both decisions, so a vote and the flip it causes are one row-locked write: two
 * approvers racing re-evaluate against each other's committed vote (READ COMMITTED re-checks the
 * WHERE on the newer row), so neither is lost and the quorum flips exactly once. A repeated
 * approver matches no row (`approvals @> [{ approver }]`).
 */
export const SQL_MCP_CONFIRMATION_DECIDE = `
update x_mcp_confirmations set
  approvals = case when $2::text = 'approved'
    then approvals || jsonb_build_array(jsonb_build_object(
      'approver', $3::text, 'at', $4::timestamptz, 'signature', $5::text))
    else approvals end,
  status = case
    when $2::text = 'rejected' then 'rejected'
    when jsonb_array_length(approvals) + 1 >= quorum then 'approved'
    else 'pending' end,
  decided_by = case
    when $2::text = 'rejected' or jsonb_array_length(approvals) + 1 >= quorum then $3::text
    else decided_by end,
  decided_at = case
    when $2::text = 'rejected' or jsonb_array_length(approvals) + 1 >= quorum then $4::timestamptz
    else decided_at end
where id = $1 and status = 'pending' and consumed_at is null and expires_at > $4::timestamptz
  and ($2::text = 'rejected'
    or not approvals @> jsonb_build_array(jsonb_build_object('approver', $3::text)))
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
  readonly quorum: number | string;
  /** `jsonb`: decoded by `Bun.SQL`, a string from a client that leaves it as text. */
  readonly approvers: unknown;
  readonly approvals: unknown;
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
          draft.quorum ?? 1,
          draft.approvers === undefined || draft.approvers === null
            ? null
            : JSON.stringify(draft.approvers),
        ]);
        if (created !== undefined) return { row: created, created: true };
        const held = await first(SQL_MCP_CONFIRMATION_OPEN_ROW, [
          draft.actorId,
          draft.orgId,
          draft.tool,
          draft.inputDigest,
        ]);
        if (held !== undefined) return { row: held, created: false };
      }
      // Never reported as created: the caller would tell the agent a row exists that does not.
      throw new McpConfirmationContestedError(draft.tool);
    },
    get: (id) => first(SQL_MCP_CONFIRMATION_GET, [id]),
    decide: (id, status, by, at, signature) =>
      first(SQL_MCP_CONFIRMATION_DECIDE, [id, status, by, at, signature]),
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
    quorum: Number(row.quorum),
    approvers: selectorsOf(row.approvers),
    approvals: approvalsOf(row.approvals),
  };
}

/** A client that leaves `jsonb` as text hands back its JSON; text that is not JSON reads as junk. */
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    // Not JSON: a hand-edited cell, read by both callers as the shape that refuses.
    return MALFORMED;
  }
}

const MALFORMED = Symbol('malformed');

/** `null` stays "any admitted decider"; a non-array is a hand-edited row and admits NOBODY. */
function selectorsOf(value: unknown): readonly string[] | null {
  const held = decoded(value);
  if (held === null || held === undefined) return null;
  // Anything else that is not an array, MALFORMED included, admits nobody.
  if (!Array.isArray(held)) return [];
  return held.filter((one): one is string => typeof one === 'string');
}

/**
 * Votes as stored. A malformed entry is dropped rather than repaired: it then counts toward no
 * quorum, so a hand-edited row reads as fewer approvals — the reading that can only refuse.
 */
function approvalsOf(value: unknown): McpConfirmationApproval[] {
  const held = decoded(value);
  if (!Array.isArray(held)) return [];
  const votes: McpConfirmationApproval[] = [];
  for (const entry of held) {
    if (typeof entry !== 'object' || entry === null) continue;
    const approver: unknown = Reflect.get(entry, 'approver');
    const at: unknown = Reflect.get(entry, 'at');
    const signature: unknown = Reflect.get(entry, 'signature');
    if (typeof approver !== 'string' || typeof at !== 'string') continue;
    if (signature !== null && typeof signature !== 'string') continue;
    votes.push({ approver, at: new Date(at), signature });
  }
  return votes;
}
