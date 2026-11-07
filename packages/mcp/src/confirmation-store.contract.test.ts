// One contract, two stores: the memory store every test uses and the Postgres store a fleet needs
// must answer every transition identically — or a confirmation approved on one replica is a
// different fact on the next. Postgres runs against `TEST_DATABASE_URL` through `Bun.SQL` (this
// package never opens an `@ultimat3/db` client); unset, that half skips.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases, uuidV7 } from '@ultimat3/core';
import { postgresConfirmationStore } from './confirmation-postgres';
import { SQL_MCP_CONFIRMATIONS_TABLE } from './confirmation-schema';
import type { McpConfirmationDraft, McpConfirmationStore } from './confirmation-store';
import { memoryConfirmationStore } from './confirmation-store';

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

function contract(name: string, fresh: () => Promise<McpConfirmationStore>): void {
  describe(`contract · ${name} confirmation store`, () => {
    let store: McpConfirmationStore;
    beforeEach(async () => {
      store = await fresh();
    });

    test('open creates one pending row, and a second open for the same call returns it', async () => {
      const first = await store.open(draft());
      expect(first.created).toBe(true);
      expect(first.row).toMatchObject({
        status: 'pending',
        decidedAt: null,
        consumedAt: null,
        sealedArguments: 'x1.sealed-elsewhere',
      });
      expect(first.row.expiresAt.getTime()).toBe(at(600).getTime());
      const again = await store.open(draft());
      expect(again.created).toBe(false);
      expect(again.row.id).toBe(first.row.id);
    });

    test('a different actor, org, tool or input is a different call', async () => {
      const base = await store.open(draft());
      for (const over of [
        { actorId: 'agent-2' },
        { orgId: 'org-2' },
        { orgId: null },
        { orgId: '' },
        { tool: 'other' },
        { inputDigest: 'b'.repeat(64) },
      ]) {
        const other = await store.open(draft(over));
        expect(other.created).toBe(true);
        expect(other.row.id).not.toBe(base.row.id);
      }
    });

    test('an approval in one org is not the open row of the same actor and call in another', async () => {
      const { row } = await store.open(draft({ orgId: 'o1' }));
      await store.decide(row.id, 'approved', 'user-9', at(10), null);
      const other = await store.open(draft({ orgId: 'o2' }));
      expect(other.created).toBe(true);
      expect(other.row).toMatchObject({ status: 'pending', orgId: 'o2' });
      const again = await store.open(draft({ orgId: 'o1' }));
      expect(again).toMatchObject({ created: false, row: { id: row.id, status: 'approved' } });
      expect((await store.open(draft({ orgId: 'o2' }))).row.id).toBe(other.row.id);
      // Consuming one org's row frees only that org's key.
      expect(await store.consume(row.id, at(20))).toBe(true);
      expect((await store.open(draft({ orgId: 'o2' }))).row.id).toBe(other.row.id);
    });

    test('decide moves pending to a decision once, and never a second time', async () => {
      const { row } = await store.open(draft());
      const approved = await store.decide(row.id, 'approved', 'user-9', at(10), null);
      expect(approved).toMatchObject({ status: 'approved', decidedBy: 'user-9' });
      expect(approved?.decidedAt?.getTime()).toBe(at(10).getTime());
      expect(await store.decide(row.id, 'rejected', 'user-9', at(11), null)).toBeUndefined();
      expect((await store.get(row.id))?.status).toBe('approved');
    });

    test('decide refuses a row past its expiry, and an unknown id', async () => {
      const { row } = await store.open(draft());
      expect(await store.decide(row.id, 'approved', 'user-9', at(600), null)).toBeUndefined();
      expect(await store.decide(uuidV7(), 'approved', 'user-9', at(1), null)).toBeUndefined();
      expect(await store.get(uuidV7())).toBeUndefined();
    });

    test('consume takes a row exactly once, and a consumed row frees the call for a new one', async () => {
      const { row } = await store.open(draft());
      expect(await store.consume(row.id, at(20))).toBe(true);
      expect(await store.consume(row.id, at(21))).toBe(false);
      expect((await store.get(row.id))?.consumedAt?.getTime()).toBe(at(20).getTime());
      const next = await store.open(draft());
      expect(next.created).toBe(true);
      expect(next.row.id).not.toBe(row.id);
      // A consumed row can no longer be decided: its call has already been answered.
      expect(await store.decide(row.id, 'approved', 'user-9', at(22), null)).toBeUndefined();
    });

    test('a quorum row counts one vote per approver and flips to approved at the quorum', async () => {
      const { row } = await store.open(
        draft({ quorum: 2, approvers: ['role:finance', 'actor:user-7'] }),
      );
      expect(row).toMatchObject({ quorum: 2, approvers: ['role:finance', 'actor:user-7'] });
      expect(row.approvals).toEqual([]);
      const first = await store.decide(row.id, 'approved', 'user-7', at(10), 'sig-7');
      expect(first).toMatchObject({ status: 'pending', decidedBy: null, decidedAt: null });
      expect(first?.approvals).toEqual([{ approver: 'user-7', at: at(10), signature: 'sig-7' }]);
      // The same approver again is no vote at all — the row is unchanged.
      expect(await store.decide(row.id, 'approved', 'user-7', at(11), 'sig-7')).toBeUndefined();
      expect((await store.get(row.id))?.approvals).toHaveLength(1);
      const second = await store.decide(row.id, 'approved', 'user-8', at(12), null);
      expect(second).toMatchObject({ status: 'approved', decidedBy: 'user-8' });
      expect(second?.decidedAt?.getTime()).toBe(at(12).getTime());
      expect(second?.approvals.map((vote) => [vote.approver, vote.signature])).toEqual([
        ['user-7', 'sig-7'],
        ['user-8', null],
      ]);
      expect(await store.decide(row.id, 'approved', 'user-9', at(13), null)).toBeUndefined();
    });

    test('one rejection settles a partly approved row, and a draft without a bar needs one', async () => {
      const { row } = await store.open(draft({ quorum: 3, approvers: ['role:finance'] }));
      await store.decide(row.id, 'approved', 'user-7', at(10), null);
      const rejected = await store.decide(row.id, 'rejected', 'user-8', at(11), null);
      expect(rejected).toMatchObject({ status: 'rejected', decidedBy: 'user-8' });
      expect(await store.decide(row.id, 'approved', 'user-9', at(12), null)).toBeUndefined();
      const plain = await store.open(draft({ tool: 'plain' }));
      expect(plain.row).toMatchObject({ quorum: 1, approvers: null, approvals: [] });
    });

    test('approvers racing lose no vote, and the quorum flips the row exactly once', async () => {
      const { row } = await store.open(draft({ quorum: 2, approvers: ['role:finance'] }));
      const votes = await Promise.all(
        ['user-1', 'user-2', 'user-3'].map((by) =>
          store.decide(row.id, 'approved', by, at(10), null),
        ),
      );
      // Two land (the second flips it), the third finds it approved; whichever order they ran in.
      expect(votes.filter((vote) => vote !== undefined)).toHaveLength(2);
      const held = await store.get(row.id);
      expect(held?.status).toBe('approved');
      expect(held?.approvals).toHaveLength(2);
    });

    test('a vote past the expiry is refused even with the quorum half met', async () => {
      const { row } = await store.open(draft({ quorum: 2, approvers: ['role:finance'] }));
      await store.decide(row.id, 'approved', 'user-7', at(10), null);
      expect(await store.decide(row.id, 'approved', 'user-8', at(600), null)).toBeUndefined();
      expect((await store.get(row.id))?.status).toBe('pending');
    });

    test('purge deletes what expired before the instant, and counts it', async () => {
      await store.open(draft({ expiresAt: at(60) }));
      const live = await store.open(draft({ tool: 'kept', expiresAt: at(6000) }));
      expect(await store.purge(at(120))).toBe(1);
      expect(await store.get(live.row.id)).toBeDefined();
    });
  });
}

contract('memory', async () => memoryConfirmationStore());

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_mcp_confirmations_contract');

describe.skipIf(!hasPostgres)('postgres', () => {
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

  contract('postgres', async () => {
    await sql.unsafe('truncate x_mcp_confirmations');
    return postgresConfirmationStore({ executor });
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
