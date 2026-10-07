// What a live query puts on a socket, and what the replicator puts on the bus, for an entity with
// sealed columns: a snapshot built from repository rows, and patches built from write-ahead-log
// rows. The WAL holds the STORED string, so the plaintext is never there to leak — but the stored
// string is not for the wire either (a lookup column's reveals which rows are equal), and the
// slice says omitted. Asserted on the raw bytes each frame is sent as.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, seal, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { from, type QueryPolicy, query, registerQuery, resetQueries, t } from '@ultimat3/query';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { Row } from './json';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { entityRow } from './pg-entity-row';
import type { PgRelation } from './pgoutput';
import { SyncSocket, type WsLike } from './socket';

const CANARY = 'PLAINTEXT-CANARY-7f3a';
const LOOKUP_CANARY = 'LOOKUP-CANARY-91be';
const SEALED = /x1\.[0-9a-f]{16}\./;

const accounts = entity('rs_accounts', {
  columns: {
    id: uuid().primaryKey(),
    name: text(),
    credential: text().sealed(),
    contact: text().sealed({ lookup: true }),
  },
});
type Account = typeof accounts.$row;

const table = database({ accounts }, { driver: memoryDriver() }).accounts;

/** Structural, as `live-definition.test.ts` builds its own: realtime reaches policy through query. */
const anyone: QueryPolicy = {
  kind: 'allow',
  label: 'account:read',
  permissions: [],
  children: [],
  run: () => ({ allowed: true }),
};

beforeAll(async () => {
  await table.insert({ name: 'Ada', credential: CANARY, contact: LOOKUP_CANARY });
});

afterAll(() => {
  resetQueries();
  clearRegistry();
});

/** Keeps the bytes, not the decoded frame: what is asserted is what a client receives. */
class RawWs implements WsLike {
  readonly sent: string[] = [];
  send(data: string): number {
    this.sent.push(data);
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

const relation: PgRelation = {
  oid: 1,
  schema: 'public',
  name: 'rs_accounts',
  replicaIdentity: 'f',
  columns: [
    { key: true, name: 'id', typeOid: 2950, typeMod: -1 },
    { key: false, name: 'name', typeOid: 25, typeMod: -1 },
    { key: false, name: 'credential', typeOid: 25, typeMod: -1 },
    { key: false, name: 'contact', typeOid: 25, typeMod: -1 },
  ],
};

/** The tuple logical replication carries: the physical row, sealed columns exactly as stored. */
const walTuple = async (id: string, name: string): Promise<Record<string, string>> => ({
  id,
  name,
  credential: await seal(CANARY, { purpose: 'entity:rs_accounts.credential' }),
  contact: await seal(LOOKUP_CANARY, {
    purpose: 'entity:rs_accounts.contact',
    deterministic: true,
  }),
});

const clean = (bytes: string, mustCarry: string): void => {
  expect(bytes).toContain(mustCarry);
  expect(bytes).not.toContain(CANARY);
  expect(bytes).not.toContain(LOOKUP_CANARY);
  expect(bytes).not.toMatch(SEALED);
  expect(bytes).not.toContain('credential');
  expect(bytes).not.toContain('contact');
};

describe('unit · a sealed column reaches no socket and no bus', () => {
  test('a row decoded off the write-ahead log has no sealed property — not even the stored string', async () => {
    const tuple = await walTuple('0198c1a0-0000-7000-8000-000000000002', 'Grace');
    expect(tuple['credential']).toMatch(SEALED);
    for (const image of ['before', 'after'] as const) {
      const row = entityRow(relation, tuple, image);
      expect(row).toEqual({ id: '0198c1a0-0000-7000-8000-000000000002', name: 'Grace' });
      expect(Object.hasOwn(row, 'credential')).toBe(false);
      // The replicator publishes `JSON.stringify({ ...change })` to every node: this is that row.
      clean(JSON.stringify({ after: row }), 'Grace');
    }
  });

  test('the snapshot frame and the patch frame, as bytes', async () => {
    const target = registerQuery(
      'sealedAccounts',
      query({
        input: t.object({}),
        policy: anyone,
        live: true,
        sql: () =>
          from<Account & Row>('rs_accounts', () => table.all() as Promise<(Account & Row)[]>)
            .orderBy('name')
            .limit(50),
      }),
    );
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      liveQueryDefinition(target, { ctx: ctxOf({ role: 'sync', buildId: 'build-1' }) }),
    );
    const ws = new RawWs();
    const socket = new SyncSocket({
      ws,
      id: 's-1',
      clientBuildId: 'build-1',
      serverBuildId: 'build-1',
      actor: userActor({ id: 'reader' }),
    });

    const first = await registry.subscribe({ socket, name: 'sealedAccounts', input: {} });
    expect(first.frame.type).toBe('snapshot');
    clean(JSON.stringify(first.frame), 'Ada');

    // A second row is inserted: what the replicator hands the fanout is the decoded WAL tuple.
    const tuple = await walTuple('0198c1a0-0000-7000-8000-000000000003', 'Grace');
    const change: ChangeEvent = {
      table: 'rs_accounts',
      op: 'insert',
      before: null,
      after: entityRow(relation, tuple, 'after') as Row,
      lsn: formatLsn(2),
      txid: '2',
      orgId: null,
      at: 1_000,
      write: null,
    };
    ws.sent.length = 0;
    expect(await registry.deliver(change)).toBe(1);
    expect(ws.sent).toHaveLength(1);
    clean(ws.sent.join('\n'), 'Grace');
  });
});
