// The DDL of `mcpConfirmations`' one framework table, and nothing else: a LEAF module, so the
// boot's `FRAMEWORK_SCHEMA` (`@ultimat3/cli`) applies it in every role through
// `@ultimat3/mcp/schema` without pulling the MCP server, its transports or `@ultimat3/action`
// into a worker's module graph. Imports nothing, by design.

/** The table. One name, read by this DDL and by `confirmation-postgres.ts`'s statements. */
export const MCP_CONFIRMATIONS_TABLE = 'x_mcp_confirmations';

/**
 * Applied by the boot, never by an app migration — the rule `SQL_IDEMPOTENCY_TABLE` follows.
 * `create … if not exists` throughout, so every boot can run it; a new column is an
 * `alter table … add column if not exists`, never an edit to the `create`.
 */
export const SQL_MCP_CONFIRMATIONS_TABLE = `
create table if not exists x_mcp_confirmations (
  id           uuid        primary key,
  actor_id     text        not null,
  org_id       text,
  tool         text        not null,
  input_digest text        not null,
  status       text        not null default 'pending',
  created_at   timestamptz not null,
  expires_at   timestamptz not null,
  decided_at   timestamptz,
  decided_by   text,
  consumed_at  timestamptz
);

create unique index if not exists x_mcp_confirmations_open_idx
  on x_mcp_confirmations (actor_id, tool, input_digest) where consumed_at is null;

create index if not exists x_mcp_confirmations_expires_at_idx on x_mcp_confirmations (expires_at);
`;
