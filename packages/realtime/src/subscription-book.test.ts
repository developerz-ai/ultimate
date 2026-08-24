import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import { SubscriptionLimitError } from './errors';
import type { LiveSubscription } from './live-contract';
import { SyncSocket, type WsLike } from './socket';
import { SubscriptionBook, subscriptionKey } from './subscription-book';

const ws: WsLike = {
  send: () => 1,
  close: () => undefined,
  subscribe: () => undefined,
  unsubscribe: () => undefined,
  getBufferedAmount: () => 0,
};

function socketFor(id: string, actor: Actor | null = null): SyncSocket {
  return new SyncSocket({ ws, id, clientBuildId: 'b', serverBuildId: 'b', actor });
}

function subscriptionFor(socket: SyncSocket, sid: string): LiveSubscription {
  return {
    sid,
    qid: `q:${sid}`,
    socket,
    input: null,
    definition: {
      name: 'q',
      entities: [],
      snapshot: async () => ({ rows: [], lsn: '' }),
      visible: () => true,
      matcher: () =>
        ({ affects: () => false, apply: () => ({ patches: [], refill: false }) }) as never,
    },
    cursor: { qid: `q:${sid}`, lsn: '', ids: [], at: 0 },
  };
}

const tenantOf = (actor: Actor | null): string | null => actor?.orgId ?? null;

describe('the subscription book', () => {
  test('ofSocket answers from a per-socket index, not a scan of the node', () => {
    const book = new SubscriptionBook();
    const mine = socketFor('mine');
    const other = socketFor('other');
    book.add(subscriptionFor(mine, 'a'));
    book.add(subscriptionFor(other, 'a'));
    book.add(subscriptionFor(mine, 'b'));

    expect(
      book
        .ofSocket('mine')
        .map((s) => s.sid)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(book.ofSocket('other').map((s) => s.sid)).toEqual(['a']);
    expect(book.ofSocket('nobody')).toEqual([]);
    // The composite identity still holds: two sockets may hold the same sid.
    expect(book.get('mine', 'a')?.socket.id).toBe('mine');
    expect(book.get('other', 'a')?.socket.id).toBe('other');

    book.delete('mine', 'a');
    expect(book.ofSocket('mine').map((s) => s.sid)).toEqual(['b']);
    expect(book.get('other', 'a')).toBeDefined();
    expect(
      book
        .all()
        .map((s) => subscriptionKey(s.socket.id, s.sid))
        .sort(),
    ).toEqual([subscriptionKey('mine', 'b'), subscriptionKey('other', 'a')].sort());
  });

  test('the returned list is a copy, so a caller may unsubscribe while walking it', () => {
    const book = new SubscriptionBook();
    const socket = socketFor('s');
    for (const sid of ['a', 'b', 'c']) book.add(subscriptionFor(socket, sid));
    let walked = 0;
    for (const subscription of book.ofSocket('s')) {
      book.delete('s', subscription.sid);
      walked += 1;
    }
    expect(walked).toBe(3);
    expect(book.ofSocket('s')).toEqual([]);
  });

  test('the per-tenant count is answered in O(1) and tracks add, delete and re-auth', () => {
    const book = new SubscriptionBook({ maxPerTenant: 3, tenantOf });
    const alice = socketFor('a', userActor({ id: 'alice', orgId: 'o1' }));
    const bob = socketFor('b', userActor({ id: 'bob', orgId: 'o1' }));
    const carol = socketFor('c', userActor({ id: 'carol', orgId: 'o2' }));
    book.add(subscriptionFor(alice, '1'));
    book.add(subscriptionFor(alice, '2'));
    book.add(subscriptionFor(bob, '1'));

    expect(book.tenantCount('o1')).toBe(3);
    expect(book.tenantCount('o2')).toBe(0);
    expect(() => book.assertCapacity(bob)).toThrow(SubscriptionLimitError);
    // Another tenant is unaffected by o1's cap.
    expect(() => book.assertCapacity(carol)).not.toThrow();

    book.delete('a', '1');
    expect(book.tenantCount('o1')).toBe(2);
    expect(() => book.assertCapacity(bob)).not.toThrow();

    // A re-auth that moves a socket to another org moves its subscriptions with it, or the count
    // the cap reads drifts from the book for the rest of the process.
    bob.actor = userActor({ id: 'bob', orgId: 'o2' });
    book.retenant(bob);
    expect(book.tenantCount('o1')).toBe(1);
    expect(book.tenantCount('o2')).toBe(1);
  });

  test('the per-socket cap refuses with the scope that decided', () => {
    const book = new SubscriptionBook({ maxPerSocket: 2 });
    const socket = socketFor('s');
    socket.queries.set('1', 'q1');
    socket.queries.set('2', 'q2');
    expect(() => book.assertCapacity(socket)).toThrow(/socket s reached the subscription cap of 2/);
  });

  test('adding the same (socket, sid) twice does not double-count a tenant', () => {
    const book = new SubscriptionBook({ maxPerTenant: 10, tenantOf });
    const socket = socketFor('s', userActor({ id: 'u', orgId: 'o1' }));
    book.add(subscriptionFor(socket, '1'));
    book.add(subscriptionFor(socket, '1'));
    expect(book.tenantCount('o1')).toBe(1);
    expect(book.ofSocket('s').length).toBe(1);
  });

  test('a reserved slot counts against both caps before anything is added', () => {
    const book = new SubscriptionBook({ maxPerSocket: 2, maxPerTenant: 2, tenantOf });
    const socket = socketFor('s', userActor({ id: 'u', orgId: 'o1' }));

    const first = book.reserve(socket, '1');
    const second = book.reserve(socket, '2');

    // Nothing has been added yet — a subscribe is three awaits from holding anything — and this is
    // exactly the window N frames from one WebSocket write arrive in.
    expect(book.ofSocket('s')).toEqual([]);
    expect(() => book.reserve(socket, '3')).toThrow(/socket s reached the subscription cap of 2/);

    first.release();
    expect(() => book.reserve(socket, '3')).not.toThrow();
    second.release();
  });

  test('the tenant cap counts reservations ACROSS sockets, where no lane can see them', () => {
    // `maxPerSocket` is deliberately out of reach here: one socket claiming three would refuse at
    // the socket cap first, and the tenant counter would never have been the thing that decided.
    const book = new SubscriptionBook({ maxPerSocket: 10, maxPerTenant: 2, tenantOf });
    const one = socketFor('s1', userActor({ id: 'u1', orgId: 'o1' }));
    const two = socketFor('s2', userActor({ id: 'u2', orgId: 'o1' }));
    const other = socketFor('s3', userActor({ id: 'u3', orgId: 'o2' }));

    const first = book.reserve(one, '1');
    book.reserve(two, '1');

    // Two sockets, one tenant, two slots — and the third is refused for the TENANT, on a socket
    // that has claimed one of its ten. A per-socket check would have admitted it.
    expect(() => book.reserve(two, '2')).toThrow(/tenant o1 reached the subscription cap of 2/);
    expect(() => book.reserve(one, '2')).toThrow(SubscriptionLimitError);
    // …and another tenant is untouched by it.
    expect(() => book.reserve(other, '1')).not.toThrow();

    first.release();
    expect(() => book.reserve(one, '2')).not.toThrow();
  });

  test('releasing twice gives back one slot, not two', () => {
    const book = new SubscriptionBook({ maxPerSocket: 1 });
    const socket = socketFor('s');
    const slot = book.reserve(socket, '1');
    slot.release();
    slot.release();

    book.reserve(socket, '2');
    expect(() => book.reserve(socket, '3')).toThrow(SubscriptionLimitError);
  });

  test('a sid already claimed is refused, so two frames cannot both attach it', () => {
    const book = new SubscriptionBook();
    const socket = socketFor('s');
    book.reserve(socket, 'S');

    expect(() => book.reserve(socket, 'S')).toThrow(/X_SUBSCRIPTION_ID_TAKEN/);
    // Another socket's identical sid is a different subscription — the composite key holds here too.
    expect(() => book.reserve(socketFor('other'), 'S')).not.toThrow();
  });

  test('a release gives the slot back to the tenant that took it, not the one a re-auth moved to', () => {
    const book = new SubscriptionBook({ maxPerTenant: 1, tenantOf });
    const socket = socketFor('s', userActor({ id: 'u', orgId: 'o1' }));
    const slot = book.reserve(socket, '1');

    // The grant was renewed mid-read and this socket now belongs to another org.
    socket.actor = userActor({ id: 'u', orgId: 'o2' });
    book.retenant(socket);
    slot.release();

    // Derived again at release time, this would have decremented o2 — which never took a slot —
    // and left o1 counting a subscription that does not exist for the rest of the process.
    const other = socketFor('t', userActor({ id: 'v', orgId: 'o1' }));
    expect(() => book.reserve(other, '1')).not.toThrow();
  });

  // The regression this file exists for. `ofSocket` copied the whole node's map on every call, so
  // one mass event — a deploy, a network blip, grants expiring together — cost
  // sockets x subscriptions: 100,000 entries measured at 17.7 SECONDS of blocking main-thread work
  // on the machine this was written on, during which the node answers no heartbeat, patch or
  // accept. The ceiling is deliberately generous; an O(N^2) regression is three orders out.
  test('2,000 sockets x 50 subscriptions sweep in bounded time', () => {
    const book = new SubscriptionBook();
    const sockets: SyncSocket[] = [];
    for (let s = 0; s < 2000; s += 1) {
      const socket = socketFor(`s${s}`, userActor({ id: `u${s}`, orgId: `org${s % 4}` }));
      sockets.push(socket);
      for (let q = 0; q < 50; q += 1) book.add(subscriptionFor(socket, `sid${q}`));
    }
    const started = Bun.nanoseconds();
    let seen = 0;
    for (const socket of sockets) seen += book.ofSocket(socket.id).length;
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    expect(seen).toBe(100_000);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
