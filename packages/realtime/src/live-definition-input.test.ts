// A live window is keyed by the input the query PARSED, never by the bytes a client sent: a key
// the schema strips must not open a second window, a second build and a second fan-out lane.

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { from, type QueryPolicy, query, resetQueries, t } from '@ultimat3/query';
import { registerQuery } from '@ultimat3/query/loader';
import { RingChangeBuffer } from './change-buffer';
import type { LiveRow } from './json';
import { liveQueryDefinition } from './live-definition';
import { LiveQueryRegistry } from './live-query';
import { SyncSocket, type WsLike } from './socket';

const allowAll: QueryPolicy = {
  kind: 'allow',
  label: 'post:read',
  permissions: [],
  children: [],
  run: () => ({ allowed: true }),
};

let builds = 0;
let reads = 0;

function registry(maxWindows?: number): LiveQueryRegistry {
  const target = registerQuery(
    'junkFeed',
    query({
      input: t.object({ orgId: t.string }),
      policy: allowAll,
      live: true,
      sql: ({ orgId }) => {
        builds += 1;
        return from<LiveRow & { orgId: string }>('posts', async () => {
          reads += 1;
          return [{ id: 'p1', orgId }];
        })
          .where({ orgId })
          .orderBy('id')
          .limit(50);
      },
    }),
  );
  const ctx = ctxOf({ role: 'sync', buildId: 'build-1' });
  return new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
    liveQueryDefinition(target, { ctx, ...(maxWindows === undefined ? {} : { maxWindows }) }),
  );
}

class CountingWs implements WsLike {
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

function socket(id: string): { socket: SyncSocket; ws: CountingWs } {
  const ws = new CountingWs();
  const actor = userActor({ id: 'alice', orgId: 'o1' });
  return {
    socket: new SyncSocket({ ws, id, clientBuildId: 'b', serverBuildId: 'b', actor }),
    ws,
  };
}

describe('a live window is keyed by the parsed input', () => {
  beforeEach(() => {
    resetQueries();
    builds = 0;
    reads = 0;
  });

  test('two subscribes differing by a junk key share one entry and one build', async () => {
    const live = registry();
    const first = await live.subscribe({
      socket: socket('s1').socket,
      name: 'junkFeed',
      input: { orgId: 'o1' },
    });
    const second = await live.subscribe({
      socket: socket('s2').socket,
      name: 'junkFeed',
      input: { orgId: 'o1', junk: 'n1' },
    });
    expect(second.subscription.qid).toBe(first.subscription.qid);
    expect(live.subscriberCount(first.subscription.qid)).toBe(2);
    expect(builds).toBe(1);
    // One read per subscribe — a join re-reads the shared window — and no window of its own.
    expect(reads).toBe(2);
  });

  test('a re-auth in the same tenant does not re-seat a subscription its junk key names', async () => {
    const live = registry();
    const held = socket('s1');
    await live.subscribe({
      socket: held.socket,
      name: 'junkFeed',
      input: { orgId: 'o1', junk: 1 },
    });
    const sentBefore = held.ws.sent;
    const readsBefore = reads;
    expect(await live.reauthorize(held.socket)).toEqual([]);
    // A re-seat is an unsubscribe, a subscribe and a snapshot frame: none of them is owed here.
    expect(held.ws.sent).toBe(sentBefore);
    expect(reads).toBe(readsBefore);
  });

  test('a window evicted between `prepare` and the entry still gets the matcher it resolved', async () => {
    // Concurrent subscribes over a one-window cache: each `prepare` can evict the other's window
    // before that subscribe builds its entry. A matcher looked up again then was UNRESOLVED — an
    // entry reading no table, so no change ever reached it.
    const live = registry(1);
    const inputs = ['o1', 'o2', 'o3'].map((orgId) => ({ orgId, junk: orgId }));
    const served = await Promise.all(
      inputs.map((input, i) =>
        live.subscribe({ socket: socket(`s${i}`).socket, name: 'junkFeed', input }),
      ),
    );
    // Every subscriber's window reads `posts`, so every one of them is a reader of it.
    expect(live.invalidate('posts')).toBe(inputs.length);
    // And every snapshot names the row scope that same `prepare` resolved.
    expect(served.map(({ frame }) => frame.type === 'snapshot' && frame.entity)).toEqual(
      inputs.map(() => 'posts'),
    );
  });

  test('an input the schema refuses is still refused with the query error', async () => {
    const live = registry();
    await expect(
      live.subscribe({ socket: socket('s1').socket, name: 'junkFeed', input: { orgId: 7 } }),
    ).rejects.toMatchObject({ code: 'X_INPUT_INVALID' });
  });
});
