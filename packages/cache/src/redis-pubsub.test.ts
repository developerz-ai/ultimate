// The Redis pub/sub hop, on a fake that behaves as Bun 1.4.4 was measured to: a reconnect fires
// `onconnect`, the server has forgotten the subscription, and the client still holds the listener.
// `packages/cli/src/runtime-cache-redis.live.test.ts` holds them against a real server.

import { describe, expect, test } from 'bun:test';
import type { PubSubListener, RedisPublisherLike, RedisSubscriberLike } from './redis-pubsub';
import { PUBLISHER_CONNECT_WAIT_MS, redisPubSub } from './redis-pubsub';

/** What Bun refuses a command with while the connection is down: input to the hop, not a verdict. */
const CONNECTION_CLOSED = new TypeError('ERR_REDIS_CONNECTION_CLOSED');
/** Bun 1.4.4 THROWS this, synchronously, from `unsubscribe` on a client holding no listener. */
const NOT_SUBSCRIBER_MODE = new TypeError('ERR_REDIS_INVALID_STATE');

/** One server's channels, and the clients' local listener lists that outlive a connection. */
class FakeServer {
  readonly live = new Map<string, Set<FakeSubscriber>>();
  /** The publishing connection's state: it dials in the background and fires `onconnect`. */
  connected = true;
  onconnect: RedisPublisherLike['onconnect'] = null;
  dialled = Promise.withResolvers<undefined>();
  connect(): Promise<void> {
    return this.dialled.promise;
  }
  /** The publisher's connection goes; a `connect()` from now waits for `back()`. */
  down(): void {
    this.connected = false;
    this.dialled = Promise.withResolvers<undefined>();
  }
  /** It comes back, as Bun's reconnect loop brings it: connected, then `onconnect`. */
  back(): void {
    this.connected = true;
    this.dialled.resolve(undefined);
    this.onconnect?.call(Object.create(null));
  }
  close(): void {
    this.connected = false;
  }
  publish(channel: string, message: string): Promise<number> {
    if (!this.connected) return Promise.reject(new TypeError('offline queue is disabled'));
    const subscribers = [...(this.live.get(channel) ?? [])];
    for (const subscriber of subscribers) subscriber.deliver(channel, message);
    return Promise.resolve(subscribers.length);
  }
}

class FakeSubscriber implements RedisSubscriberLike {
  onconnect: RedisSubscriberLike['onconnect'] = null;
  /** Kept across a drop, as Bun keeps them. */
  readonly local = new Map<string, PubSubListener[]>();
  up = true;
  /** Set by a test to hold every SUBSCRIBE's reply until it resolves the gate. */
  gate: Promise<unknown> | undefined;
  constructor(readonly server: FakeServer) {}
  async subscribe(channel: string, listener: PubSubListener): Promise<number> {
    if (!this.up) throw CONNECTION_CLOSED;
    await this.gate;
    this.local.set(channel, [...(this.local.get(channel) ?? []), listener]);
    const set = this.server.live.get(channel) ?? new Set();
    set.add(this);
    this.server.live.set(channel, set);
    return set.size;
  }
  unsubscribe(channel: string): Promise<void> {
    if (this.local.size === 0) throw NOT_SUBSCRIBER_MODE;
    this.local.delete(channel);
    this.server.live.get(channel)?.delete(this);
    return Promise.resolve();
  }
  deliver(channel: string, message: string): void {
    for (const listener of this.local.get(channel) ?? []) listener(message, channel);
  }
  connect(): void {
    this.up = true;
    this.onconnect?.call(Object.create(null));
  }
  /** The server drops the connection: it forgets the subscription; the client does not. */
  drop(): void {
    this.up = false;
    for (const set of this.server.live.values()) set.delete(this);
  }
  close(): void {
    this.drop();
  }
}

/** Event-loop turns, never wall time: a resubscribe is a short chain of resolved promises. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Bun.sleep(0);
};

/** A bus whose first connect has landed and been announced. */
async function pair() {
  const server = new FakeServer();
  const subscriber = new FakeSubscriber(server);
  const bus = redisPubSub({ publisher: server, subscriber });
  subscriber.connect();
  await settle();
  return { server, subscriber, bus };
}

describe('redisPubSub', () => {
  test('a publish reaches every subscribed handler, as the payload published', async () => {
    const { bus } = await pair();
    const heard: string[] = [];
    await bus.subscribe('x.cache.invalidate', (payload) => heard.push(payload));
    await bus.publish('x.cache.invalidate', '["post:1"]');
    expect(heard).toEqual(['["post:1"]']);
    expect(bus.name).toBe('redis');
  });

  test('a reconnect resubscribes once, then says so — never a doubled delivery', async () => {
    const { subscriber, bus } = await pair();
    const heard: string[] = [];
    let reconnects = 0;
    bus.onReconnect(() => {
      reconnects += 1;
    });
    await bus.subscribe('x.cache.invalidate', (payload) => heard.push(payload));

    subscriber.drop();
    await bus.publish('x.cache.invalidate', 'lost');
    subscriber.connect();
    await settle();

    expect(reconnects).toBe(1);
    await bus.publish('x.cache.invalidate', 'after');
    expect(heard).toEqual(['after']);
  });

  test('the first connect is announced: a bust refused during boot is owed from then', async () => {
    const server = new FakeServer();
    const subscriber = new FakeSubscriber(server);
    const bus = redisPubSub({ publisher: server, subscriber });
    let reconnects = 0;
    bus.onReconnect(() => {
      reconnects += 1;
    });
    subscriber.connect();
    await settle();
    expect(reconnects).toBe(1);
  });

  test("a publish in the publisher's first milliseconds waits for its connect", async () => {
    const { server, bus } = await pair();
    const heard: string[] = [];
    await bus.subscribe('x.cache.invalidate', (payload) => heard.push(payload));
    server.down();
    const published = bus.publish('x.cache.invalidate', '["post:1"]');
    server.back();
    await published;
    expect(heard).toEqual(['["post:1"]']);
  });

  test('a publisher that never connects is refused after the one bounded wait', async () => {
    const { server, bus } = await pair();
    server.down();
    const first = await bus.publish('x', 'a').then(
      () => 'sent',
      () => 'refused',
    );
    const started = performance.now();
    const second = await bus.publish('x', 'b').then(
      () => 'sent',
      () => 'refused',
    );
    expect([first, second]).toEqual(['refused', 'refused']);
    // The wait is the outage's first publish's, never every publish's.
    expect(performance.now() - started).toBeLessThan(PUBLISHER_CONNECT_WAIT_MS / 2);
  });

  test('a refused subscribe is thrown to the caller and holds nothing', async () => {
    const { subscriber, bus } = await pair();
    subscriber.up = false;
    const refused = await bus
      .subscribe('x.cache.invalidate', () => undefined)
      .then(
        () => 'landed',
        () => 'refused',
      );
    expect(refused).toBe('refused');
    // A later reconnect has no channel to restore.
    subscriber.connect();
    await settle();
    expect(subscriber.local.size).toBe(0);
  });

  test('unsubscribe and close leave the server holding nothing', async () => {
    const { server, subscriber, bus } = await pair();
    const subscription = await bus.subscribe('x.cache.invalidate', () => undefined);
    subscription.unsubscribe();
    await settle();
    expect(server.live.get('x.cache.invalidate')?.size ?? 0).toBe(0);
    await bus.close();
    expect(subscriber.onconnect).toBeNull();
  });
  // Concurrency audit: Redis restarts, the subscriber is back first, the hop's settle publishes on
  // a publisher still down and re-defers. Nothing said the publisher was back: peers stayed stale.
  test("the publisher's return is announced, so what it refused is published", async () => {
    const { server, bus } = await pair();
    let reconnects = 0;
    bus.onReconnect(() => {
      reconnects += 1;
    });
    server.down();
    server.back();
    await settle();
    expect(reconnects).toBe(1);
  });

  test('every outage gets its bounded wait for the publisher, not only the first', async () => {
    const { server, bus } = await pair();
    const heard: string[] = [];
    await bus.subscribe('x.cache.invalidate', (payload) => heard.push(payload));
    for (const payload of ['["post:1"]', '["post:2"]']) {
      server.down();
      const published = bus.publish('x.cache.invalidate', payload);
      // The publish is waiting on the publisher when it comes back — not sent after.
      await settle();
      server.back();
      await published;
    }
    expect(heard).toEqual(['["post:1"]', '["post:2"]']);
  });

  test('a flapping connection resubscribes one at a time: every bust is delivered once', async () => {
    const { subscriber, bus } = await pair();
    const heard: string[] = [];
    await bus.subscribe('x.cache.invalidate', (payload) => heard.push(payload));
    const gate = Promise.withResolvers<undefined>();
    subscriber.gate = gate.promise;
    subscriber.drop();
    subscriber.connect();
    subscriber.connect();
    await settle();
    gate.resolve(undefined);
    await settle();
    subscriber.gate = undefined;
    await bus.publish('x.cache.invalidate', 'once');
    expect(heard).toEqual(['once']);
  });

  test('a subscribe beside a resubscribe registers its channel once', async () => {
    const { subscriber, bus } = await pair();
    const heard: string[] = [];
    await bus.subscribe('a', (payload) => heard.push(payload));
    const gate = Promise.withResolvers<undefined>();
    subscriber.gate = gate.promise;
    subscriber.drop();
    subscriber.connect();
    const landed = bus.subscribe('b', (payload) => heard.push(payload));
    await settle();
    gate.resolve(undefined);
    await landed;
    await settle();
    subscriber.gate = undefined;
    await bus.publish('a', 'a1');
    await bus.publish('b', 'b1');
    expect(heard).toEqual(['a1', 'b1']);
  });
});
