import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import type { ChangeEvent } from './changefeed';
import { formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import { type LiveQueryDefinition, LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });

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

const rows: Row[] = [
  { id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'alice draft', likes: 0 },
  { id: 'p2', orgId: 'o1', ownerId: 'bob', title: 'bob draft', likes: 0 },
];

/** One query, one read, one matcher — and a row policy evaluated per subscriber. */
const liveFeed: LiveQueryDefinition = {
  name: 'liveFeed',
  entities: ['posts'],
  columns: ['title', 'likes', 'ownerId'],
  async snapshot() {
    return { rows, lsn: formatLsn(1) };
  },
  visible({ actor: subject, row }) {
    return row['ownerId'] === subject?.id;
  },
  matcher() {
    return {
      entities: ['posts'],
      match: (change) => {
        const patch = patchFromChange(change);
        return { patches: patch ? [patch] : [], refill: false };
      },
    };
  },
};

function socketFor(id: string, who: Actor): { socket: SyncSocket; ws: FakeWs } {
  const ws = new FakeWs();
  const socket = new SyncSocket({
    ws,
    id,
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    actor: who,
  });
  return { socket, ws };
}

function change(after: Row, before: Row | null): ChangeEvent {
  return {
    entity: 'posts',
    op: 'update',
    before,
    after,
    lsn: formatLsn(2),
    txid: '2',
    orgId: 'o1',
    at: 1_000,
  };
}

describe('live queries', () => {
  test('two actors on one live query get different rows', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(liveFeed);
    const alice = socketFor('s-alice', actor('alice'));
    const bob = socketFor('s-bob', actor('bob'));
    const input: JsonValue = { orgId: 'o1' };

    const first = await registry.subscribe({ socket: alice.socket, name: 'liveFeed', input });
    const second = await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input });

    expect(first.frame.type).toBe('snapshot');
    expect(second.frame.type).toBe('snapshot');
    if (first.frame.type !== 'snapshot' || second.frame.type !== 'snapshot') {
      throw new Error('unreachable');
    }
    expect(first.frame.rows.map((row) => row.id)).toEqual(['p1']);
    expect(second.frame.rows.map((row) => row.id)).toEqual(['p2']);
    // One query id, one read, two result sets: the read is shared, the authz is not.
    expect(first.subscription.qid).toBe(second.subscription.qid);
    expect(registry.subscriberCount(first.subscription.qid)).toBe(2);
  });

  test('a patch is delivered only to the subscriber whose policy admits the row', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(liveFeed);
    const alice = socketFor('s-alice', actor('alice'));
    const bob = socketFor('s-bob', actor('bob'));
    const input: JsonValue = { orgId: 'o1' };
    await registry.subscribe({ socket: alice.socket, name: 'liveFeed', input });
    await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input });
    alice.ws.frames.length = 0;
    bob.ws.frames.length = 0;

    const target = rows[1] as Row;
    const sent = await registry.deliver(change({ ...target, likes: 1 }, target));

    expect(sent).toBe(1);
    expect(alice.ws.frames).toHaveLength(0);
    expect(bob.ws.frames).toHaveLength(1);
    const frame = bob.ws.frames[0];
    if (frame?.type !== 'patch') throw new Error('expected a patch frame');
    // Minimal patch: the changed column plus the id, never the whole row.
    expect(frame.patches[0]?.row).toEqual({ id: 'p2', likes: 1 });
  });

  test('a row that leaves an actor policy arrives as a delete, never as silence', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(liveFeed);
    const bob = socketFor('s-bob', actor('bob'));
    const input: JsonValue = { orgId: 'o1' };
    await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input });
    bob.ws.frames.length = 0;

    const target = rows[1] as Row;
    await registry.deliver(change({ ...target, ownerId: 'carol' }, target));

    const frame = bob.ws.frames[0];
    if (frame?.type !== 'patch') throw new Error('expected a patch frame');
    expect(frame.patches[0]?.op).toBe('delete');
    expect(frame.patches[0]?.id).toBe('p2');
  });

  test('an unknown query name is a protocol error, not an empty result', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() });
    const alice = socketFor('s-alice', actor('alice'));
    expect(
      registry.subscribe({ socket: alice.socket, name: 'nope', input: null }),
    ).rejects.toThrow();
  });
});
