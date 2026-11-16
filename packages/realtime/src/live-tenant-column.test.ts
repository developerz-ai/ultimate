// A live window is per tenant, whatever the tenant column is CALLED. The in-process replicator read
// `row.orgId` while `entity(name, { tenant: 'workspaceId' })` is legal, so every change on such a
// table carried no tenant and another org's insert was patched into every org's window. And the
// last line: a tenanted table's change that carries no tenant never reaches an org-scoped window.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Actor, ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { from, query, resetQueries, t } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { type LiveReplicator, startLiveReplicator } from './live-replicator';
import { canAffect, type SubscriptionShape } from './matcher-bridge';
import { OPEN_POLICY } from './policy-fake-fixture';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

const byWorkspace = entity('tc_docs_ws', {
  tenant: 'workspaceId',
  columns: { id: uuid().primaryKey(), workspaceId: uuid(), label: text({ max: 40 }) },
});
const byOrg = entity('tc_docs_org', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), label: text({ max: 40 }) },
});
const driver = memoryDriver();
const db = database({ byWorkspace, byOrg }, { driver });

afterAll(() => {
  clearRegistry();
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

const as = <T>(actor: Actor, run: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor }), run);
const alice = userActor({ id: 'alice', orgId: A });
const mallory = userActor({ id: 'mallory', orgId: B });
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let registry: LiveQueryRegistry;
let replicator: LiveReplicator;

beforeEach(async () => {
  resetQueries();
  driver.reset?.();
  const feed = (name: string, table: string, read: () => Promise<readonly { id: string }[]>) =>
    registerQuery(
      name,
      query({
        input: t.object({}),
        policy: OPEN_POLICY,
        live: true,
        sql: () =>
          from<{ id: string; label: string }>(table, read as never)
            .orderBy('id')
            .limit(50),
      }),
    );
  registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
  const ctx = ctxOf({ role: 'sync', buildId: 'b' });
  const lsn = () => registry.lastLsn;
  const readWs = () => db.byWorkspace.orderBy('id').limit(50).all();
  const readOrg = () => db.byOrg.orderBy('id').limit(50).all();
  registry.register(liveQueryDefinition(feed('feedWs', 'tc_docs_ws', readWs), { ctx, lsn }));
  registry.register(liveQueryDefinition(feed('feedOrg', 'tc_docs_org', readOrg), { ctx, lsn }));
  replicator = await startLiveReplicator({ registry });
});
afterEach(() => replicator.stop());

const labelsSeen = (ws: FakeWs): unknown[] =>
  ws.frames.flatMap((frame) =>
    frame.type === 'snapshot'
      ? frame.rows.map((row) => row['label'])
      : frame.type === 'patch'
        ? frame.patches.map((patch) => patch.row?.['label'])
        : [],
  );

/** Alice subscribes in org A; then org A and org B each insert one row. What did Alice see? */
async function aliceSees(
  name: string,
  insert: (n: number, actor: Actor, label: string) => Promise<unknown>,
): Promise<unknown[]> {
  await insert(1, alice, 'alice-before');
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    id: 's1',
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: alice,
  });
  const subscribed = await registry.subscribe({ socket, name, input: {} });
  ws.frames.unshift(subscribed.frame as Frame);
  await insert(2, mallory, 'ORG-B-SECRET');
  await insert(3, alice, 'alice-after');
  await replicator.settled();
  return labelsSeen(ws);
}

describe('the in-process replicator scopes a change by the entity’s declared tenant column', () => {
  test('a column named orgId: org B’s row never reaches org A’s window, org A’s own does', async () => {
    const seen = await aliceSees('feedOrg', (n, actor, label) =>
      as(actor, () => db.byOrg.insert({ id: id(n), orgId: actor.orgId as string, label })),
    );
    expect(seen).toEqual(['alice-before', 'alice-after']);
  });

  test('tenant: workspaceId: org B’s row never reaches org A’s window, org A’s own does', async () => {
    const seen = await aliceSees('feedWs', (n, actor, label) =>
      as(actor, () =>
        db.byWorkspace.insert({ id: id(n), workspaceId: actor.orgId as string, label }),
      ),
    );
    expect(seen).toEqual(['alice-before', 'alice-after']);
  });

  // The window's own half of the defence: whatever a producer sends, a tenant-less change on a
  // tenanted table is not patched into an org-scoped window that the registry built.
  test('a tenant-less change delivered straight to the registry never reaches org A', async () => {
    const seen = await aliceSees('feedWs', async (n, actor, label) => {
      if (actor === alice) {
        return as(actor, () => db.byWorkspace.insert({ id: id(n), workspaceId: A, label }));
      }
      const row = { id: id(n), workspaceId: B, label };
      return registry.deliver({
        table: 'tc_docs_ws',
        op: 'insert',
        before: null,
        after: row,
        lsn: 'ffffffffffffffff',
        txid: 'x',
        orgId: null,
        at: 0,
        write: null,
      });
    });
    expect(seen).not.toContain('ORG-B-SECRET');
  });
});

describe('canAffect fails closed on a tenanted table’s change that carries no tenant', () => {
  const change = (orgId: string | null): ChangeEvent => ({
    table: 'tc_docs_ws',
    op: 'insert',
    before: null,
    after: { id: id(9), workspaceId: B, label: 'x' },
    lsn: '0000000000000001',
    txid: '1',
    orgId,
    at: 1,
    write: null,
  });
  const shape = (orgId: string | null, tenantTables: readonly string[]): SubscriptionShape => ({
    qid: 'q',
    entities: ['tc_docs_ws'],
    orgId,
    tenantTables,
  });

  test('an org-scoped window over a tenanted table refuses a tenant-less change', () => {
    expect(canAffect(shape(A, ['tc_docs_ws']), change(null))).toBe(false);
  });

  test('a window of the same org still takes its own change', () => {
    expect(canAffect(shape(A, ['tc_docs_ws']), change(A))).toBe(true);
    expect(canAffect(shape(A, ['tc_docs_ws']), change(B))).toBe(false);
  });

  test('an untenanted table’s change still reaches an org-scoped window', () => {
    expect(canAffect(shape(A, []), change(null))).toBe(true);
  });

  test('a window scoped to no org is not narrowed', () => {
    expect(canAffect(shape(null, ['tc_docs_ws']), change(null))).toBe(true);
  });
});
