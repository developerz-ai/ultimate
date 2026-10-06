// One contract, two stores: the memory store every test uses and the Postgres store a fleet needs
// must answer every transition identically — or a confirmation approved on one replica is a
// different fact on the next. Postgres runs against `TEST_DATABASE_URL` through `Bun.SQL` (this
// package may never import `@ultimat3/db`); unset, that half skips.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { uuid } from '@ultimat3/core';
import { postgresConfirmationStore } from './confirmation-postgres';
import { SQL_MCP_CONFIRMATIONS_TABLE } from './confirmation-schema';
import type { McpConfirmationDraft, McpConfirmationStore } from './confirmation-store';
import { memoryConfirmationStore } from './confirmation-store';

const T0 = Date.parse('2026-10-06T09:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const draft = (over: Partial<McpConfirmationDraft> = {}): McpConfirmationDraft => ({
  id: uuid(),
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

    test('a different actor, tool or input is a different call', async () => {
      const base = await store.open(draft());
      for (const over of [
        { actorId: 'agent-2' },
        { tool: 'other' },
        { inputDigest: 'b'.repeat(64) },
      ]) {
        const other = await store.open(draft(over));
        expect(other.created).toBe(true);
        expect(other.row.id).not.toBe(base.row.id);
      }
    });

    test('decide moves pending to a decision once, and never a second time', async () => {
      const { row } = await store.open(draft());
      const approved = await store.decide(row.id, 'approved', 'user-9', at(10));
      expect(approved).toMatchObject({ status: 'approved', decidedBy: 'user-9' });
      expect(approved?.decidedAt?.getTime()).toBe(at(10).getTime());
      expect(await store.decide(row.id, 'rejected', 'user-9', at(11))).toBeUndefined();
      expect((await store.get(row.id))?.status).toBe('approved');
    });

    test('decide refuses a row past its expiry, and an unknown id', async () => {
      const { row } = await store.open(draft());
      expect(await store.decide(row.id, 'approved', 'user-9', at(600))).toBeUndefined();
      expect(await store.decide(uuid(), 'approved', 'user-9', at(1))).toBeUndefined();
      expect(await store.get(uuid())).toBeUndefined();
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
      expect(await store.decide(row.id, 'approved', 'user-9', at(22))).toBeUndefined();
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
const PROBE_DB = 'x_mcp_confirmations_contract';

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
    await admin.unsafe(`create database ${PROBE_DB}`);
    const probe = new URL(url ?? '');
    probe.pathname = `/${PROBE_DB}`;
    sql = new Bun.SQL(probe.toString());
    for (const statement of SQL_MCP_CONFIRMATIONS_TABLE.split(';')) {
      if (statement.trim().length > 0) await sql.unsafe(statement);
    }
  });

  afterAll(async () => {
    await sql.close();
    await admin.unsafe(`drop database if exists ${PROBE_DB} with (force)`);
    await admin.close();
  });

  contract('postgres', async () => {
    await sql.unsafe('truncate x_mcp_confirmations');
    return postgresConfirmationStore({ executor });
  });

  test('the DDL is re-runnable: every boot applies it', async () => {
    for (const statement of SQL_MCP_CONFIRMATIONS_TABLE.split(';')) {
      if (statement.trim().length > 0) await sql.unsafe(statement);
    }
  });
});
