// The embedded `x dev` node, as `registerLiveQueries` builds it: a client that reconnects inside
// the retained window is answered with a DELTA. Before any change arrives the node's position is
// `''`, and a snapshot that claimed `''` gave the retained ring no floor a cursor could resume
// from — every reconnect on a fresh dev node was a second snapshot.
import { afterAll, describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { from, query, registerQuery, resetRegistry, t } from '@ultimat3/query';
import { formatLsn, SyncSocket } from '@ultimat3/realtime/server';
import type { StartRolesOptions } from './role-start';
import { registerLiveQueries } from './role-sync';

afterAll(() => {
  resetRegistry();
});

const ws = {
  send: (data: string) => data.length,
  close: () => {},
  subscribe: () => {},
  unsubscribe: () => {},
  getBufferedAmount: () => 0,
};

const socketFor = (id: string): SyncSocket =>
  new SyncSocket({
    ws,
    id,
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: userActor({ id: 'alice', orgId: 'o1' }),
  });

describe('unit · registerLiveQueries · resume', () => {
  test('a reconnect inside the retained window is a delta, not a second snapshot', async () => {
    const rows = [{ id: 'p1', orgId: 'o1', likes: 0 }];
    registerQuery(
      'resumeFeed',
      query({
        input: t.object({ orgId: t.string }),
        policy: {
          kind: 'allow',
          label: 'public',
          permissions: [],
          children: [],
          run: () => ({ allowed: true }),
        },
        live: true,
        sql: ({ orgId }) =>
          from<{ id: string; orgId: string; likes: number }>('posts', async () => rows)
            .where({ orgId })
            .orderBy('id')
            .limit(50),
      }),
    );
    const registry = registerLiveQueries({ buildId: 'build-1' } as StartRolesOptions);
    const input = { orgId: 'o1' };

    const cold = await registry.subscribe({ socket: socketFor('s1'), name: 'resumeFeed', input });
    if (cold.frame.type !== 'snapshot') return expect.unreachable('expected a snapshot frame');
    // What the CLIENT holds: the cursor its snapshot frame carried, at the position it was read.
    const held = cold.frame.cursor;
    // No change has reached this node, so the read is marked with the node's own origin.
    expect(held.lsn.startsWith('!')).toBe(true);
    await registry.deliver({
      entity: 'posts',
      op: 'update',
      before: rows[0] ?? null,
      after: { id: 'p1', orgId: 'o1', likes: 1 },
      lsn: formatLsn(7),
      txid: '7',
      orgId: 'o1',
      at: held.at,
    });

    // The same client, on a new socket, with the cursor its first snapshot handed it.
    const resumed = await registry.subscribe({
      socket: socketFor('s2'),
      name: 'resumeFeed',
      input,
      cursor: held,
    });

    expect(resumed.frame.type).toBe('patch');
    if (resumed.frame.type !== 'patch') return expect.unreachable('expected a patch frame');
    expect(resumed.frame.patches.map((patch) => patch.id)).toEqual(['p1']);
  });
});
