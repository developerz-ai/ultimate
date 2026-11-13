// The Redis pub/sub hop, on a fake that behaves as Bun 1.4.4 was measured to: a reconnect fires
// `onconnect`, the server has forgotten the subscription, and the client still holds the listener.
// `packages/cli/src/runtime-cache-redis.live.test.ts` holds them against a real server.

import { describe, expect, test } from 'bun:test';
import type { Scheduler } from '@ultimat3/core';
import type { PubSubListener, RedisPublisherLike, RedisSubscriberLike } from './redis-pubsub';
import {
  cacheBusConnectionName,
  PUBLISHER_CONNECT_WAIT_MS,
  PUBSUB_COMMAND_TIMEOUT_MS,
  redisPubSub,
} from './redis-pubsub';

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
  /** The next N SUBSCRIBEs are refused with the connection UP — what `CLIENT KILL` left behind. */
  refuse = 0;
  constructor(readonly server: FakeServer) {}
  async subscribe(channel: string, listener: PubSubListener): Promise<number> {
    if (!this.up) throw CONNECTION_CLOSED;
    if (this.refuse > 0) {
      this.refuse -= 1;
      throw CONNECTION_CLOSED;
    }
    await this.gate;
    this.local.set(channel, [...(this.local.get(channel) ?? []), listener]);
    const set = this.server.live.get(channel) ?? new Set();
    set.add(this);
    this.server.live.set(channel, set);
    return set.size;
  }
  /** Every `CLIENT SETNAME` this connection was sent, in order. */
  readonly names: string[] = [];
  send(command: string, args: string[]): Promise<unknown> {
    if (!this.up) return Promise.reject(CONNECTION_CLOSED);
    if (command === 'CLIENT' && args[0] === 'SETNAME') this.names.push(args[1] ?? '');
    return Promise.resolve('OK');
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

/** A scheduler a case fires by hand: a retry's backoff and a command's deadline, no wall clock. */
function manualSchedule() {
  const pending = new Set<{ readonly fn: () => void; readonly ms: number }>();
  const schedule: Scheduler = (fn, ms) => {
    const entry = { fn, ms };
    pending.add(entry);
    return () => pending.delete(entry);
  };
  return {
    schedule,
    armed: (): readonly number[] => [...pending].map((entry) => entry.ms),
    /** Fires every pending timer armed with `ms`; answers how many fired. */
    fire(ms: number): number {
      const due = [...pending].filter((entry) => entry.ms === ms);
      for (const entry of due) {
        pending.delete(entry);
        entry.fn();
      }
      return due.length;
    },
  };
}

/** A bus whose first connect has landed and been announced. */
async function pair(clock = manualSchedule()) {
  const server = new FakeServer();
  const subscriber = new FakeSubscriber(server);
  const bus = redisPubSub({
    publisher: server,
    subscriber,
    schedule: clock.schedule,
    resubscribeRetryMs: () => RETRY_MS,
  });
  subscriber.connect();
  await settle();
  return { server, subscriber, bus, clock };
}

/** The retry delay the cases inject: any value the manual scheduler can name. */
const RETRY_MS = 7;

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
    const { server, bus, clock } = await pair();
    server.down();
    const first = bus.publish('x', 'a').then(
      () => 'sent',
      () => 'refused',
    );
    await settle();
    expect(clock.fire(PUBLISHER_CONNECT_WAIT_MS)).toBe(1);
    // The wait is the outage's first publish's, never every publish's: nothing is armed for this one.
    const second = await bus.publish('x', 'b').then(
      () => 'sent',
      () => 'refused',
    );
    expect([await first, second]).toEqual(['refused', 'refused']);
    expect(clock.armed()).not.toContain(PUBLISHER_CONNECT_WAIT_MS);
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

  // Live flake 'a dropped subscription is restored': after `CLIENT KILL` the reconnect's SUBSCRIBE
  // was refused with the connection up, the failure was logged once, and nothing asked again — a
  // replica deaf to every peer bust for the life of the connection.
  test('a resubscribe refused with the connection up is retried on the backoff until it lands', async () => {
    const { subscriber, bus, clock } = await pair();
    const heard: string[] = [];
    let reconnects = 0;
    bus.onReconnect(() => {
      reconnects += 1;
    });
    await bus.subscribe('x.cache.invalidate', (payload) => heard.push(payload));
    subscriber.drop();
    subscriber.refuse = 2;
    subscriber.connect();
    await settle();
    expect(reconnects).toBe(0);
    expect(clock.fire(RETRY_MS)).toBe(1);
    await settle();
    expect(reconnects).toBe(0);
    expect(clock.fire(RETRY_MS)).toBe(1);
    await settle();
    // Restored and announced, so the replica drops what it held while deaf.
    expect(reconnects).toBe(1);
    expect(clock.armed()).not.toContain(RETRY_MS);
    await bus.publish('x.cache.invalidate', 'after');
    expect(heard).toEqual(['after']);
  });

  test('a subscriber command that never answers is bounded: the lane moves on', async () => {
    const { subscriber, bus, clock } = await pair();
    const heard: string[] = [];
    let reconnects = 0;
    bus.onReconnect(() => {
      reconnects += 1;
    });
    await bus.subscribe('x.cache.invalidate', (payload) => heard.push(payload));
    subscriber.drop();
    // A SUBSCRIBE sent on a socket that died under it: its reply never comes.
    subscriber.gate = new Promise(() => undefined);
    subscriber.connect();
    await settle();
    expect(clock.fire(PUBSUB_COMMAND_TIMEOUT_MS)).toBe(1);
    subscriber.gate = undefined;
    await settle();
    // The stalled step is failed, not waited on: the retry it schedules is what restores it.
    expect(clock.fire(RETRY_MS)).toBe(1);
    await settle();
    expect(reconnects).toBe(1);
    await bus.publish('x.cache.invalidate', 'after');
    expect(heard.at(-1)).toBe('after');
  });

  test('a reconnect supersedes a pending retry: one resubscribe, never two', async () => {
    const { subscriber, bus, clock } = await pair();
    await bus.subscribe('x.cache.invalidate', () => undefined);
    subscriber.drop();
    subscriber.refuse = 1;
    subscriber.connect();
    await settle();
    expect(clock.armed()).toContain(RETRY_MS);
    subscriber.connect();
    await settle();
    expect(clock.armed()).not.toContain(RETRY_MS);
  });

  test('close cancels a pending retry', async () => {
    const { subscriber, bus, clock } = await pair();
    await bus.subscribe('x.cache.invalidate', () => undefined);
    subscriber.drop();
    subscriber.refuse = 1;
    subscriber.connect();
    await settle();
    await bus.close();
    expect(clock.armed()).not.toContain(RETRY_MS);
  });

  // A reconnect is a NEW server-side connection with no name: named once, it is anonymous after
  // the first `CLIENT KILL`, and `CLIENT LIST` can no longer say which replica is deaf.
  test('every connect names the subscriber connection before it subscribes', async () => {
    const server = new FakeServer();
    const subscriber = new FakeSubscriber(server);
    const bus = redisPubSub({ publisher: server, subscriber, connectionName: 'x-cache-bus:7' });
    subscriber.connect();
    await settle();
    await bus.subscribe('x.cache.invalidate', () => undefined);
    subscriber.drop();
    subscriber.connect();
    await settle();
    expect(subscriber.names).toEqual(['x-cache-bus:7', 'x-cache-bus:7']);
  });

  test("the default name carries this process's pid: one replica's connection is findable", () => {
    expect(cacheBusConnectionName()).toBe(`x-cache-bus:${String(process.pid)}`);
  });
});
