// One actor may not fill the node. Live-query windows are node-wide (`maxEntries`, 10,000), and an
// actor opening sockets at 128 subscriptions each reached that in 79 sockets — after which every
// other user's next subscribe was `X_SUBSCRIPTION_LIMIT`. The per-actor ceiling spans the actor's
// sockets; an anonymous socket is the actor its resolved client address names.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { formatLsn } from './changefeed';
import type { LiveQueryDefinition } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { SyncSocket, type WsLike } from './socket';
import { DEFAULT_MAX_PER_ACTOR, SubscriptionBook } from './subscription-book';

const ws: WsLike = {
  send: (data) => data.length,
  close() {},
  subscribe() {},
  unsubscribe() {},
  getBufferedAmount: () => 0,
};

const feed: LiveQueryDefinition = {
  name: 'feed',
  entities: ['posts'],
  async snapshot() {
    return { rows: [], lsn: formatLsn(1) };
  },
  visible: () => true,
  matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
};

let sockets = 0;
const socketFor = (actor: Actor | null, clientAddress: string | null = null): SyncSocket => {
  sockets += 1;
  return new SyncSocket({
    ws,
    id: `s-${String(sockets)}`,
    clientBuildId: 'b',
    serverBuildId: 'b',
    actor,
    clientAddress,
  });
};

const codeOf = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

/** The shape of the attack: many sockets, each under its own cap, every input distinct. */
async function flood(
  registry: LiveQueryRegistry,
  open: () => SyncSocket,
  sockets: number,
  perSocket: number,
): Promise<readonly string[]> {
  const seen: string[] = [];
  let n = 0;
  for (let s = 0; s < sockets; s += 1) {
    const socket = open();
    for (let i = 0; i < perSocket; i += 1) {
      n += 1;
      seen.push(await codeOf(registry.subscribe({ socket, name: 'feed', input: { n } })));
    }
  }
  return seen;
}

describe('one actor cannot fill the node', () => {
  test('an actor stops at its ceiling across sockets, and another actor still subscribes', async () => {
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxEntries: 20,
      maxPerSocket: 4,
      maxPerActor: 6,
    }).register(feed);
    const mallory = userActor({ id: 'mallory', orgId: 'o1' });
    const seen = await flood(registry, () => socketFor(mallory), 5, 4);
    expect(seen.filter((code) => code === 'ok')).toHaveLength(6);
    expect(seen.filter((code) => code === 'X_SUBSCRIPTION_LIMIT')).toHaveLength(14);

    const alice = socketFor(userActor({ id: 'alice', orgId: 'o1' }));
    expect(
      await codeOf(registry.subscribe({ socket: alice, name: 'feed', input: { n: -1 } })),
    ).toBe('ok');
  });

  test('the refusal names the actor scope and the app.config.ts key that raises it', async () => {
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerActor: 1,
    }).register(feed);
    const socket = socketFor(userActor({ id: 'mallory' }));
    await registry.subscribe({ socket, name: 'feed', input: { n: 1 } });
    const refused = await registry
      .subscribe({ socket: socketFor(userActor({ id: 'mallory' })), name: 'feed', input: { n: 2 } })
      .then(
        () => undefined,
        (error: unknown) => error as { code: string; cause: string; fix: string },
      );
    expect(refused?.code).toBe('X_SUBSCRIPTION_LIMIT');
    expect(refused?.cause).toContain('actor');
    expect(refused?.cause).toContain('of 1');
    expect(refused?.fix).toContain('realtime.maxSubscriptionsPerActor');
    expect(refused?.fix).toContain('app.config.ts');
    // A host building its own registry never reads that key: the option it sets is named too.
    expect(refused?.fix).toContain('maxPerActor on new LiveQueryRegistry');
  });

  test('an anonymous address is bounded the same way, and another address is not', async () => {
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerSocket: 4,
      maxPerActor: 6,
    }).register(feed);
    const seen = await flood(registry, () => socketFor(null, '198.51.100.7'), 3, 4);
    expect(seen.filter((code) => code === 'ok')).toHaveLength(6);
    const elsewhere = socketFor(null, '203.0.113.9');
    expect(
      await codeOf(registry.subscribe({ socket: elsewhere, name: 'feed', input: { n: -1 } })),
    ).toBe('ok');
  });

  test('unsubscribing gives the slot back', async () => {
    const registry = new LiveQueryRegistry({
      source: new RingChangeBuffer(),
      maxPerActor: 1,
    }).register(feed);
    const first = socketFor(userActor({ id: 'u' }));
    await registry.subscribe({ socket: first, name: 'feed', input: { n: 1 }, sid: 'a' });
    registry.unsubscribe(first.id, 'a');
    const second = socketFor(userActor({ id: 'u' }));
    expect(
      await codeOf(registry.subscribe({ socket: second, name: 'feed', input: { n: 2 } })),
    ).toBe('ok');
  });

  test('the default ceiling leaves the node cap out of any one actor’s reach', () => {
    expect(DEFAULT_MAX_PER_ACTOR).toBe(1_000);
    expect(DEFAULT_MAX_PER_ACTOR).toBeLessThan(10_000);
  });
});

describe('the per-actor count in the book', () => {
  test('reservations count across sockets, before anything is attached', () => {
    const book = new SubscriptionBook({ maxPerSocket: 10, maxPerActor: 2 });
    const u = userActor({ id: 'u' });
    const one = socketFor(u);
    const two = socketFor(u);
    book.reserve(one, '1');
    book.reserve(two, '1');
    expect(() => book.reserve(two, '2')).toThrow(/actor .* reached the subscription cap of 2/);
    expect(() => book.reserve(socketFor(userActor({ id: 'v' })), '1')).not.toThrow();
  });

  test('a re-auth to another actor moves the socket’s count with it', () => {
    const book = new SubscriptionBook({ maxPerActor: 2 });
    const socket = socketFor(userActor({ id: 'a' }));
    const subscription = (sid: string) =>
      ({
        sid,
        qid: sid,
        socket,
        input: null,
        definition: feed,
        cursor: { qid: sid, lsn: '', ids: [], at: 0 },
      }) as const;
    book.add(subscription('1'));
    book.add(subscription('2'));
    expect(() => book.assertCapacity(socketFor(userActor({ id: 'a' })))).toThrow();
    socket.actor = userActor({ id: 'b' });
    book.retenant(socket);
    expect(() => book.assertCapacity(socketFor(userActor({ id: 'a' })))).not.toThrow();
    expect(() => book.assertCapacity(socketFor(userActor({ id: 'b' })))).toThrow();
  });

  test('a non-finite ceiling is refused where the book is built', () => {
    expect(() => new SubscriptionBook({ maxPerActor: Number.NaN })).toThrow();
  });
});
