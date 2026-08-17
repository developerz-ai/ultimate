// What `subscribe` owes when several of them are in flight on one socket at once — which is the
// normal case, not the exotic one: one WebSocket write may carry N subscribe frames and the node
// dispatches them concurrently. Every rule here is a check that used to be read before the awaits
// and acted on after them, so a batch passed it N times and a socket that died during it left the
// entry behind for the life of the process.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import { type LiveQueryDefinition, qidOf } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

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

/** A promise this test resolves by hand. Never a sleep: a race is not a duration. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const actor = (id: string, orgId: string): Actor => userActor({ id, orgId });
const input: JsonValue = { orgId: 'o1' };
const rows: readonly Row[] = [{ id: 'p1', orgId: 'o1', likes: 0 }];

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

/** Counts what a live entry costs after it exists: one matcher pass per change, per query id. */
interface Feed {
  readonly definition: LiveQueryDefinition;
  matched(): number;
}

function feed(snapshot: () => Promise<{ rows: readonly Row[]; lsn: string }>): Feed {
  let matched = 0;
  return {
    matched: () => matched,
    definition: {
      name: 'liveFeed',
      entities: ['posts'],
      snapshot,
      visible: () => true,
      matcher: () => ({
        entities: ['posts'],
        match: (event) => {
          matched += 1;
          const patch = patchFromChange(event);
          return { patches: patch ? [patch] : [], refill: false };
        },
      }),
    },
  };
}

const change: ChangeEvent = {
  entity: 'posts',
  op: 'update',
  before: rows[0] as Row,
  after: { id: 'p1', orgId: 'o1', likes: 1 },
  lsn: formatLsn(2),
  txid: '2',
  orgId: 'o1',
  at: 1_000,
};

describe('a socket that goes away mid-subscribe', () => {
  test('strands neither the subscription nor the query entry behind it', async () => {
    const gate = deferred<{ rows: readonly Row[]; lsn: string }>();
    const target = feed(() => gate.promise);
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      target.definition,
    );
    const alice = socketFor('sock-1', actor('alice', 'o1'));

    const pending = registry.subscribe({
      socket: alice.socket,
      name: 'liveFeed',
      input,
      sid: 'sid-1',
    });
    // The client gave up during the read. This is what the node's own `close` callback does, in
    // this order — the book it walks has nothing in it yet, because `subscribe` has not attached.
    registry.unsubscribeSocket('sock-1');
    alice.socket.close();
    gate.resolve({ rows, lsn: formatLsn(1) });
    await pending;

    expect(registry.subscription('sock-1', 'sid-1')).toBeUndefined();
    expect(registry.subscriberCount(qidOf('liveFeed', input))).toBe(0);
    // The entry itself, not just its subscriber list: a leaked one holds a matcher, a shared row
    // window and a retained change buffer, and pays a matcher pass on every change forever.
    await registry.deliver(change);
    expect(target.matched()).toBe(0);
    expect(alice.socket.queries.size).toBe(0);
  });
});

describe('a batch of subscribe frames cannot outrun a cap', () => {
  test('the per-socket cap counts the subscribes still in flight', async () => {
    const gate = deferred<{ rows: readonly Row[]; lsn: string }>();
    const target = feed(() => gate.promise);
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerSocket: 2,
    }).register(target.definition);
    const alice = socketFor('sock-1', actor('alice', 'o1'));

    // One WebSocket write, four subscribe frames, dispatched concurrently by the node.
    const batch = [0, 1, 2, 3].map((page) =>
      registry.subscribe({
        socket: alice.socket,
        name: 'liveFeed',
        input: { orgId: 'o1', page },
        sid: `sid-${page}`,
      }),
    );
    gate.resolve({ rows, lsn: formatLsn(1) });
    const settled = await Promise.allSettled(batch);

    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(2);
    for (const one of settled.filter((each) => each.status === 'rejected')) {
      expect(one.reason).toMatchObject({ code: 'X_SUBSCRIPTION_LIMIT' });
    }
    expect(alice.socket.queries.size).toBe(2);
    // Each admitted subscribe is one entry, one matcher and one shared window — the cost the cap
    // exists to bound. Two refused ones must leave none of it behind.
    await registry.deliver(change);
    expect(target.matched()).toBe(2);
  });

  test('the per-tenant cap holds across two sockets subscribing at once', async () => {
    const gate = deferred<{ rows: readonly Row[]; lsn: string }>();
    const target = feed(() => gate.promise);
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerTenant: 1,
      tenantOf: (who) => who?.orgId ?? null,
    }).register(target.definition);
    const alice = socketFor('sock-1', actor('alice', 'o1'));
    const bob = socketFor('sock-2', actor('bob', 'o1'));

    const both = [
      registry.subscribe({ socket: alice.socket, name: 'liveFeed', input, sid: 'a' }),
      registry.subscribe({
        socket: bob.socket,
        name: 'liveFeed',
        input: { orgId: 'o1', page: 2 },
        sid: 'b',
      }),
    ];
    gate.resolve({ rows, lsn: formatLsn(1) });
    const settled = await Promise.allSettled(both);

    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    const refused = settled.find((one) => one.status === 'rejected');
    expect(refused?.reason).toMatchObject({ code: 'X_SUBSCRIPTION_LIMIT' });
  });

  test('the node-wide entry ceiling is not raised by concurrency either', async () => {
    const gate = deferred<{ rows: readonly Row[]; lsn: string }>();
    const target = feed(() => gate.promise);
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxEntries: 1,
    }).register(target.definition);
    const alice = socketFor('sock-1', actor('alice', 'o1'));

    const batch = [0, 1, 2].map((page) =>
      registry.subscribe({
        socket: alice.socket,
        name: 'liveFeed',
        input: { orgId: 'o1', page },
        sid: `sid-${page}`,
      }),
    );
    gate.resolve({ rows, lsn: formatLsn(1) });
    const settled = await Promise.allSettled(batch);

    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    await registry.deliver(change);
    expect(target.matched()).toBe(1);
  });
});

describe('a sid is claimed where it is chosen, not two awaits later', () => {
  test('two concurrent subscribes reusing one sid: the second is refused, the first survives', async () => {
    const gate = deferred<{ rows: readonly Row[]; lsn: string }>();
    const target = feed(() => gate.promise);
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(
      target.definition,
    );
    const alice = socketFor('sock-1', actor('alice', 'o1'));

    const both = [
      registry.subscribe({ socket: alice.socket, name: 'liveFeed', input, sid: 'S' }),
      registry.subscribe({
        socket: alice.socket,
        name: 'liveFeed',
        input: { orgId: 'o1', page: 2 },
        sid: 'S',
      }),
    ];
    gate.resolve({ rows, lsn: formatLsn(1) });
    const settled = await Promise.allSettled(both);

    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(settled.find((one) => one.status === 'rejected')?.reason).toMatchObject({
      code: 'X_SUBSCRIPTION_ID_TAKEN',
    });
    // Replacing rather than refusing is what strands the first inside its query entry, where
    // nothing can reach it again: one sid, one subscription, one entry.
    expect(registry.subscription('sock-1', 'S')).toBeDefined();
    expect(alice.socket.queries.size).toBe(1);
    await registry.deliver(change);
    expect(target.matched()).toBe(1);
  });
});
