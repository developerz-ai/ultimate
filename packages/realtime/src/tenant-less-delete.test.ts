// A DELETE replicated under REPLICA IDENTITY DEFAULT carries only the key, so its tenant is unknown.
// Refusing it for every org-scoped window left a deleted row on every subscriber's screen; it is let
// through instead, and only a window that already HOLDS the id turns it into a patch — a window
// holds its own tenant's rows alone, so another org learns nothing, not even the id.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { from, query, resetQueries, t } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import type { LiveRow } from './json';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { bridgeChange, canAffect, patchFromChange, type SubscriptionShape } from './matcher-bridge';
import {
  begin,
  commit,
  insert,
  POSTS_OID,
  relation,
  remove,
  start,
  xlog,
} from './pg-replication-fixture';
import { OPEN_POLICY } from './policy-fake-fixture';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

const notes = entity('tl_notes', {
  tenant: 'workspaceId',
  columns: { id: uuid().primaryKey(), workspaceId: uuid(), label: text({ max: 40 }) },
});
const driver = memoryDriver();
const db = database({ notes }, { driver });

afterAll(() => {
  clearRegistry();
});

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** What a DEFAULT-identity delete looks like once decoded: the key, and no tenant. */
const keyOnlyDelete = (row: string, lsn: string): ChangeEvent => ({
  table: 'tl_notes',
  op: 'delete',
  before: { id: row },
  after: null,
  lsn,
  txid: '1',
  orgId: null,
  at: 1,
  write: null,
});

describe('the write-ahead-log decoder under REPLICA IDENTITY DEFAULT', () => {
  test('a delete carries no tenant, and still reaches its org’s window', async () => {
    const { server, events, settled, feed } = await start({ entities: ['posts'] });
    const columns = [{ name: 'id', key: true }, { name: 'title' }, { name: 'org_id' }];
    server.push(xlog(relation(POSTS_OID, 'posts', columns, 'd')));
    server.push(xlog(begin(0xe000n, 0n, 50)));
    server.push(xlog(insert(POSTS_OID, ['p1', 't', A])));
    server.push(xlog(remove(POSTS_OID, ['p1', null, null])));
    server.push(xlog(commit(0xe000n, 0xe100n, 0n)));
    await settled(2);
    await feed.stop();
    const deleted = events.find((event) => event.op === 'delete');
    if (deleted === undefined) return expect.unreachable('the delete was replicated');
    const window: SubscriptionShape = {
      qid: 'q',
      entities: ['posts'],
      orgId: A,
      tenantTables: ['posts'],
    };
    expect({ orgId: deleted.orgId, reaches: canAffect(window, deleted) }).toEqual({
      orgId: null,
      reaches: true,
    });
  });

  test('a tenant-less insert or update on a tenanted table is still refused', () => {
    const window: SubscriptionShape = {
      qid: 'q',
      entities: ['tl_notes'],
      orgId: A,
      tenantTables: ['tl_notes'],
    };
    const row = { id: id(1), workspaceId: B, label: 'x' };
    const base = { ...keyOnlyDelete(id(1), '1'), before: null, after: row };
    expect(canAffect(window, { ...base, op: 'insert' })).toBe(false);
    expect(canAffect(window, { ...base, op: 'update', before: row })).toBe(false);
  });
});

describe('the fallback matcher (patchFromChange) deletes only what the window holds', () => {
  const shape = (orgId: string): SubscriptionShape => ({
    qid: 'q',
    entities: ['tl_notes'],
    orgId,
    tenantTables: ['tl_notes'],
  });
  const fallback = {
    entities: ['tl_notes'],
    match: (change: ChangeEvent) => {
      const patch = patchFromChange(change);
      return { patches: patch === null ? [] : [patch], refill: false };
    },
  };
  const held: LiveRow[] = [{ id: id(1), workspaceId: A, label: 'mine' }];
  const other: LiveRow[] = [{ id: id(9), workspaceId: B, label: 'theirs' }];

  test('the window that holds the row gets the delete', () => {
    const bridged = bridgeChange(shape(A), fallback, keyOnlyDelete(id(1), '1'), held);
    expect(bridged?.patches.map((patch) => [patch.op, patch.id])).toEqual([['delete', id(1)]]);
  });

  test('a window that does not hold it gets nothing — not even the id', () => {
    expect(bridgeChange(shape(B), fallback, keyOnlyDelete(id(1), '1'), other)).toBeNull();
  });
});

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

describe('a live window over the query matcher', () => {
  let registry: LiveQueryRegistry;
  beforeEach(() => {
    resetQueries();
    driver.reset?.();
    const read = () => db.notes.orderBy('id').limit(50).all();
    const target = registerQuery(
      'tlFeed',
      query({
        input: t.object({}),
        policy: OPEN_POLICY,
        live: true,
        sql: () =>
          from<{ id: string; label: string }>('tl_notes', read as never)
            .orderBy('id')
            .limit(50),
      }),
    );
    registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
    const ctx = ctxOf({ role: 'sync', buildId: 'b' });
    registry.register(liveQueryDefinition(target, { ctx, lsn: () => registry.lastLsn }));
  });

  const seat = async (actor: Actor, sid: string): Promise<FakeWs> => {
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      id: sid,
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor,
    });
    await registry.subscribe({ socket, name: 'tlFeed', input: {} });
    return ws;
  };
  const patchesOf = (ws: FakeWs) =>
    ws.frames.flatMap((frame) =>
      frame.type === 'patch' ? frame.patches.map((patch) => [patch.op, patch.id]) : [],
    );

  test('removes the row from its own org’s window and sends the other org no frame', async () => {
    const alice = userActor({ id: 'alice', orgId: A });
    const bob = userActor({ id: 'bob', orgId: B });
    const as = (actor: Actor, run: () => Promise<unknown>) => runWithContext(ctxOf({ actor }), run);
    await as(alice, () => db.notes.insert({ id: id(1), workspaceId: A, label: 'a' }));
    await as(bob, () => db.notes.insert({ id: id(2), workspaceId: B, label: 'b' }));
    const aliceWs = await seat(alice, 'sa');
    const bobWs = await seat(bob, 'sb');
    await registry.deliver(keyOnlyDelete(id(1), 'ffffffffffffffff'));
    expect(patchesOf(aliceWs)).toEqual([['delete', id(1)]]);
    expect(patchesOf(bobWs)).toEqual([]);
  });
});
