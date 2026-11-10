// The Postgres confirmation table's upgrades in place: a table from an older build gains its
// columns and its org-keyed index by the boot's own DDL. The store CONTRACT is
// `@ultimat3/testing`'s `mcpConfirmationStoreConformance`, run over memory and Postgres there.
// Runs against `TEST_DATABASE_URL` through `Bun.SQL`; unset, it skips.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases, uuidV7 } from '@ultimat3/core';
import { postgresConfirmationStore } from './confirmation-postgres';
import { SQL_MCP_CONFIRMATIONS_TABLE } from './confirmation-schema';
import type { McpConfirmationDraft } from './confirmation-store';

const T0 = Date.parse('2026-10-06T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const draft = (over: Partial<McpConfirmationDraft> = {}): McpConfirmationDraft => ({
  id: uuidV7(),
  actorId: 'agent-1',
  orgId: 'org-1',
  tool: 'refundOrder',
  inputDigest: 'a'.repeat(64),
  sealedArguments: 'x1.sealed-elsewhere',
  createdAt: at(0),
  expiresAt: at(600),
  ...over,
});

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_mcp_confirmations_contract');

describe.skipIf(!hasPostgres)('postgres · the confirmation table upgrades in place', () => {
  let admin: InstanceType<typeof Bun.SQL>;
  let sql: InstanceType<typeof Bun.SQL>;
  const executor: PgExecutor = {
    query: async <R>(text: string, params: readonly unknown[]) =>
      (await sql.unsafe(text, [...params])) as readonly R[],
  };

  beforeAll(async () => {
    admin = new Bun.SQL(url ?? '');
    await admin.unsafe(`drop database if exists ${PROBE_DB} with (force)`);
    await sweepProbeDatabases(
      {
        query: async <R>(text: string, params: readonly unknown[]) =>
          [...(await admin.unsafe(text, [...params]))] as R[],
      },
      PROBE_DB,
    );
    await admin.unsafe(`create database ${PROBE_DB}`);
    const probe = new URL(url ?? '');
    probe.pathname = `/${PROBE_DB}`;
    sql = new Bun.SQL(probe.toString());
    for (const statement of SQL_MCP_CONFIRMATIONS_TABLE.split(';')) {
      if (statement.trim().length > 0) await sql.unsafe(statement);
    }
  });

  const apply = async () => {
    for (const statement of SQL_MCP_CONFIRMATIONS_TABLE.split(';')) {
      if (statement.trim().length > 0) await sql.unsafe(statement);
    }
  };

  afterAll(async () => {
    await sql.close();
    await admin.unsafe(`drop database if exists ${PROBE_DB} with (force)`);
    await admin.close();
  });

  test('a table from before the quorum columns upgrades in place: its rows read as one approval', async () => {
    await sql.unsafe('drop table x_mcp_confirmations');
    // The shape every deployment had before `quorum`, `approvers` and `approvals` were added.
    await sql.unsafe(`create table x_mcp_confirmations (
      id uuid primary key, actor_id text not null, org_id text, tool text not null,
      input_digest text not null, sealed_arguments text not null,
      status text not null default 'pending', created_at timestamptz not null,
      expires_at timestamptz not null, decided_at timestamptz, decided_by text,
      consumed_at timestamptz)`);
    const id = uuidV7();
    await sql.unsafe(
      `insert into x_mcp_confirmations (id, actor_id, tool, input_digest, sealed_arguments,
        created_at, expires_at) values ($1, 'agent-1', 'refundOrder', 'd', 's', $2, $3)`,
      [id, at(0), at(600)],
    );
    for (const statement of SQL_MCP_CONFIRMATIONS_TABLE.split(';')) {
      if (statement.trim().length > 0) await sql.unsafe(statement);
    }
    const store = postgresConfirmationStore({ executor });
    expect(await store.get(id)).toMatchObject({ quorum: 1, approvers: null, approvals: [] });
    expect(await store.decide(id, 'approved', 'user-9', at(10), null)).toMatchObject({
      status: 'approved',
    });
  });

  test('a table with the org-blind open index upgrades in place: another org opens its own row', async () => {
    await sql.unsafe('drop table x_mcp_confirmations');
    await apply();
    // The open index every deployment had before the org joined the key.
    await sql.unsafe('drop index x_mcp_confirmations_open_org_idx');
    await sql.unsafe(`create unique index x_mcp_confirmations_open_idx
      on x_mcp_confirmations (actor_id, tool, input_digest) where consumed_at is null`);
    // An open o1 row, as the previous build wrote it.
    const id = uuidV7();
    await sql.unsafe(
      `insert into x_mcp_confirmations (id, actor_id, org_id, tool, input_digest, sealed_arguments,
        created_at, expires_at) values ($1, 'agent-1', 'o1', 'refundOrder', $2, 's', $3, $4)`,
      [id, 'a'.repeat(64), at(0), at(600)],
    );
    await apply();
    const store = postgresConfirmationStore({ executor });
    const other = await store.open(draft({ orgId: 'o2' }));
    expect(other.created).toBe(true);
    expect(other.row.id).not.toBe(id);
    expect((await store.open(draft({ orgId: 'o1' }))).row.id).toBe(id);
    const indexes = await sql.unsafe(
      "select indexname from pg_indexes where tablename = 'x_mcp_confirmations' order by 1",
    );
    expect(indexes.map((one: { indexname: string }) => one.indexname)).not.toContain(
      'x_mcp_confirmations_open_idx',
    );
  });

  test('the DDL is re-runnable: every boot applies it', async () => {
    for (const statement of SQL_MCP_CONFIRMATIONS_TABLE.split(';')) {
      if (statement.trim().length > 0) await sql.unsafe(statement);
    }
  });
});
