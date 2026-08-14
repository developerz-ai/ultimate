// What the registry does when a gate cannot reach a decision. The rule under test: a failure is
// never rendered as a denial. It does not empty a snapshot, it does not silently stop a patch
// stream, and it does not destroy a subscription — it is counted, reported, and degrades exactly
// one subscriber the way a lost window tail already does.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import { type LiveQueryDefinition, LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import type { GateFailed } from './subscriber-gate';
import { decode, type Frame } from './sync-protocol';

class Denied extends Error {
  readonly code = 'X_FORBIDDEN';
}

class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
}

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

const actor = (id: string): Actor => userActor({ id, orgId: 'o1' });
const input: JsonValue = { orgId: 'o1' };
const rows: Row[] = [
  { id: 'p1', orgId: 'o1', ownerId: 'alice', title: 'alice draft', likes: 0 },
  { id: 'p2', orgId: 'o1', ownerId: 'bob', title: 'bob draft', likes: 0 },
];

/** One definition whose two gates are swappable, so a test can break exactly one of them. */
function definitionWith(gates: {
  visible?: LiveQueryDefinition['visible'];
  authorize?: LiveQueryDefinition['authorize'];
}): LiveQueryDefinition {
  return {
    name: 'liveFeed',
    entities: ['posts'],
    async snapshot() {
      return { rows, lsn: formatLsn(1) };
    },
    visible: gates.visible ?? (() => true),
    ...(gates.authorize ? { authorize: gates.authorize } : {}),
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
}

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

const change = (after: Row, before: Row | null): ChangeEvent => ({
  entity: 'posts',
  op: 'update',
  before,
  after,
  lsn: formatLsn(2),
  txid: '2',
  orgId: 'o1',
  at: 1_000,
});

describe('a gate that cannot decide', () => {
  test('a failing snapshot gate raises out of subscribe, never an empty result set', async () => {
    const failures: GateFailed[] = [];
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      onGateFailed: (event) => failures.push(event),
    }).register(
      definitionWith({
        visible: () => {
          throw new PoolTimeout('connection pool exhausted');
        },
      }),
    );
    const alice = socketFor('s-alice', actor('alice'));

    await expect(
      registry.subscribe({ socket: alice.socket, name: 'liveFeed', input }),
    ).rejects.toThrow(PoolTimeout);

    // The drop counter is the leak-safe metric; a failure must never inflate it.
    expect(registry.rowsDenied).toBe(0);
    expect(registry.gateFailures).toBe(1);
    expect(failures[0]?.stage).toBe('snapshot');
  });

  test('one subscriber whose gate breaks is desynced; the fanout to the rest completes', async () => {
    // The pool is healthy at subscribe and dies before the first change — the only way one
    // subscriber can hold a live subscription whose gate no longer answers.
    let dead = false;
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      definitionWith({
        visible: ({ actor: subject }) => {
          if (dead && subject?.id === 'bob') throw new PoolTimeout('connection pool exhausted');
          return true;
        },
      }),
    );
    const bob = socketFor('s-bob', actor('bob'));
    const alice = socketFor('s-alice', actor('alice'));
    // Bob subscribes first, so his failure is reached before alice's delivery: the loop has to
    // carry on past it rather than abandoning everyone behind the broken subscriber.
    const first = await registry.subscribe({ socket: bob.socket, name: 'liveFeed', input });
    const second = await registry.subscribe({ socket: alice.socket, name: 'liveFeed', input });
    bob.ws.frames.length = 0;
    alice.ws.frames.length = 0;
    dead = true;

    const target = rows[1] as Row;
    const sent = await registry.deliver(change({ ...target, likes: 1 }, target));

    expect(sent).toBe(1);
    expect(alice.ws.frames).toHaveLength(1);
    expect(bob.ws.frames).toHaveLength(0);
    expect(bob.socket.desynced.has(first.subscription.sid)).toBe(true);
    expect(alice.socket.desynced.has(second.subscription.sid)).toBe(false);
    expect(registry.rowsDenied).toBe(0);
    expect(registry.gateFailures).toBe(1);
  });
});

describe('reauthorize', () => {
  test('a denial drops the subscription — the client is told it may no longer see it', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      definitionWith({
        authorize: ({ actor: subject }) => {
          if (subject?.id !== 'alice') throw new Denied('feed:read denied');
        },
      }),
    );
    const alice = socketFor('s-alice', actor('alice'));
    const { subscription } = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input,
    });

    alice.socket.actor = actor('mallory');
    const dropped = await registry.reauthorize(alice.socket);

    expect(dropped).toEqual([subscription.sid]);
    expect(registry.subscription(subscription.sid)).toBeUndefined();
    expect(registry.gateFailures).toBe(0);
  });

  test('a failure keeps the subscription, desyncs it, and is counted as a failure', async () => {
    const failures: GateFailed[] = [];
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      onGateFailed: (event) => failures.push(event),
    }).register(
      definitionWith({
        authorize: ({ actor: subject }) => {
          if (subject?.id !== 'alice') throw new PoolTimeout('connection pool exhausted');
        },
      }),
    );
    const alice = socketFor('s-alice', actor('alice'));
    const { subscription } = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input,
    });

    alice.socket.actor = actor('alice-again');
    const dropped = await registry.reauthorize(alice.socket);

    // Not dropped: a database timeout is not a revoked grant, and a client does not resubscribe
    // to a denial. Desynced instead, so the next flush re-reads under the new actor.
    expect(dropped).toEqual([]);
    expect(registry.subscription(subscription.sid)).toBeDefined();
    expect(alice.socket.desynced.has(subscription.sid)).toBe(true);
    expect(registry.gateFailures).toBe(1);
    expect(failures[0]?.stage).toBe('authorize');
    expect(failures[0]?.qid).toBe(subscription.qid);
  });

  test('an allowed subscription survives and is desynced for the new actor', async () => {
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      definitionWith({ authorize: () => undefined }),
    );
    const alice = socketFor('s-alice', actor('alice'));
    const { subscription } = await registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input,
    });

    alice.socket.actor = actor('alice-promoted');
    await expect(registry.reauthorize(alice.socket)).resolves.toEqual([]);
    expect(alice.socket.desynced.has(subscription.sid)).toBe(true);
    expect(registry.gateFailures).toBe(0);
  });
});
