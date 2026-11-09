// Which lanes one change enters. A change is only ever work for the windows that read its table —
// plus the ones that owe a re-read — so a node holding thousands of windows on other tables pays
// for none of them (finding R1, plan 101 `13-realtime.md`).

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import { WindowLock } from './window-lock';

class QuietWs implements WsLike {
  sent = 0;
  send(data: string): number {
    this.sent += 1;
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

function reading(name: string, table: string): LiveQueryDefinition {
  return {
    name,
    entities: [table],
    async snapshot() {
      return { rows: [{ id: 'r1', title: 'one' }], lsn: formatLsn(1) };
    },
    visible: () => true,
    matcher: () => ({
      entities: [table],
      match: (change) => {
        const patch = patchFromChange(change);
        return { patches: patch ? [patch] : [], refill: false };
      },
    }),
  };
}

function changeOn(table: string, lsn: number): ChangeEvent {
  const after: Row = { id: 'r1', title: `at ${String(lsn)}` };
  return {
    table,
    op: 'update',
    before: { id: 'r1', title: 'one' },
    after,
    lsn: formatLsn(lsn),
    txid: String(lsn),
    orgId: null,
    at: 1_000,
    write: null,
  };
}

const socket = (id: string): SyncSocket =>
  new SyncSocket({
    ws: new QuietWs(),
    id,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor: userActor({ id, orgId: 'o1' }),
  });

async function registryWith(posts: number): Promise<LiveQueryRegistry> {
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() })
    .register(reading('feed', 'posts'))
    .register(reading('thread', 'comments'));
  for (let i = 0; i < posts; i += 1) {
    const input: JsonValue = { page: i };
    await registry.subscribe({ socket: socket(`s-${String(i)}`), name: 'feed', input });
  }
  return registry;
}

afterEach(() => {
  // `spyOn` patches the prototype; leaving it would count every later test's lanes too.
  lanes?.mockRestore();
  lanes = null;
});
let lanes: ReturnType<typeof spyOn<WindowLock, 'run'>> | null = null;

describe('deliver — which windows a change reaches', () => {
  test('a change on a table no window reads enters no lane at all', async () => {
    const registry = await registryWith(2_000);
    lanes = spyOn(WindowLock.prototype, 'run');
    expect(await registry.deliver(changeOn('comments', 2))).toBe(0);
    expect(lanes).toHaveBeenCalledTimes(0);
  });

  test('a change on one table enters only the lanes of the windows reading it', async () => {
    const registry = await registryWith(500);
    await registry.subscribe({ socket: socket('s-thread'), name: 'thread', input: { t: 1 } });
    lanes = spyOn(WindowLock.prototype, 'run');
    expect(await registry.deliver(changeOn('comments', 2))).toBe(1);
    expect(lanes).toHaveBeenCalledTimes(1);
  });

  test('a stale window on another table is still re-read by the next change, as before', async () => {
    const registry = await registryWith(3);
    // `invalidate()` is the gap path: every window owes a re-read on the next change it meets.
    expect(registry.invalidate()).toBe(3);
    lanes = spyOn(WindowLock.prototype, 'run');
    // Three snapshots — the repair — though none of the three windows reads `comments`.
    expect(await registry.deliver(changeOn('comments', 2))).toBe(3);
    expect(lanes).toHaveBeenCalledTimes(3);
  });

  test('a window dropped by its last unsubscribe leaves the index with it', async () => {
    const registry = await registryWith(0);
    const only = socket('s-only');
    const { subscription } = await registry.subscribe({
      socket: only,
      name: 'thread',
      input: { t: 1 },
    });
    registry.unsubscribe(only.id, subscription.sid);
    lanes = spyOn(WindowLock.prototype, 'run');
    expect(await registry.deliver(changeOn('comments', 2))).toBe(0);
    expect(lanes).toHaveBeenCalledTimes(0);
  });
});

describe('deliver — a lane that cannot keep up sheds, it never grows', () => {
  // `1` is the floor a caller may write, and it is held as 2: depth counts the RUNNING task, so a
  // lane of one shed with nothing queued behind it to find the mark and re-read.
  test.each([
    [64, 64],
    [1, 2],
  ])(
    'maxLaneDepth %i: 5,000 changes behind a blocked policy queue at most %i; the window re-reads after',
    async (cap, held) => {
      let release = (): void => undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let blocking = true;
      let snapshotAt = 1;
      const ws = new QuietWs();
      const definition: LiveQueryDefinition = {
        ...reading('feed', 'posts'),
        async snapshot() {
          return { rows: [{ id: 'r1', title: 'fresh' }], lsn: formatLsn(snapshotAt) };
        },
        // One slow row rule: the first change's policy pass parks every change queued behind it.
        async visible() {
          if (blocking) await blocked;
          return true;
        },
      };
      const registry = new LiveQueryRegistry({
        source: new RingChangeBuffer(),
        maxLaneDepth: cap,
      }).register(definition);
      const viewer = new SyncSocket({
        ws,
        id: 's-viewer',
        clientBuildId: 'b',
        serverBuildId: 'b',
        actor: userActor({ id: 'viewer', orgId: 'o1' }),
      });
      // The snapshot itself passes the rule before it starts blocking.
      blocking = false;
      const { subscription } = await registry.subscribe({
        socket: viewer,
        name: 'feed',
        input: { page: 0 },
      });
      blocking = true;
      const framesBefore = ws.sent;

      lanes = spyOn(WindowLock.prototype, 'run');
      const deliveries: Promise<number>[] = [];
      for (let lsn = 2; lsn < 5_002; lsn += 1)
        deliveries.push(registry.deliver(changeOn('posts', lsn)));
      // Bounded: the lane never held more than its cap, whatever arrived.
      expect(lanes.mock.calls.length).toBeLessThanOrEqual(held);
      expect(registry.changesShed).toBe(5_000 - held);

      snapshotAt = 5_001;
      blocking = false;
      release();
      await Promise.all(deliveries);
      // The shed changes are not lost: the window was staled, so the next queued change re-read it
      // and re-snapshotted the subscriber out of rows that hold every one of them.
      expect(ws.sent).toBeGreaterThan(framesBefore);
      expect(viewer.desynced.has(subscription.sid)).toBe(false);
      expect(subscription.cursor.lsn).toBe(formatLsn(5_001));
    },
  );
});
