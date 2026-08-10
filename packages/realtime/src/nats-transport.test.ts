// Tests for the production transport: cross-node fanout, and the reconnect that re-establishes
// every subscription. Subscriptions are held as intent, so the interesting case is a bus that
// disappears mid-flight — after it returns, a publish must still reach a subscriber that never
// re-subscribed itself. Sleeps are injected so the backoff costs no wall-clock time.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { FakeNatsServer } from './nats-fake';
import type { NatsStream } from './nats-socket';
import { NatsTransport, type NatsTransportOptions } from './nats-transport';

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const settle = async (): Promise<void> => {
  await Bun.sleep(1);
};

interface Bus {
  readonly server: FakeNatsServer;
  readonly transport: (overrides?: Partial<NatsTransportOptions>) => NatsTransport;
  readonly dials: () => number;
}

function bus(): Bus {
  const clock = frozenClock(1_700_000_000_000);
  const server = new FakeNatsServer({ clock });
  let dials = 0;
  return {
    server,
    dials: () => dials,
    transport: (overrides = {}) =>
      new NatsTransport({
        url: 'nats://bus.test:4222',
        bucket: 'x-test',
        clock,
        rng: () => 0.5,
        sleep: async () => undefined,
        open: (): Promise<NatsStream> => {
          dials += 1;
          return Promise.resolve(server.connect());
        },
        ...overrides,
      }),
  };
}

describe('NatsTransport', () => {
  test('connect() opens the session and creates the bucket up front', async () => {
    const harness = bus();
    const transport = harness.transport();

    await transport.connect();

    expect(transport.connected).toBe(true);
    expect(harness.server.connections).toBe(1);
    await transport.close();
  });

  test('a change published on one node reaches a subscriber on another', async () => {
    const harness = bus();
    const publisher = harness.transport();
    const subscriber = harness.transport();
    const seen: string[] = [];

    await subscriber.subscribe('x.change.posts.*', (payload, subject) => {
      seen.push(`${subject}=${payload}`);
    });
    await publisher.publish('x.change.posts.org-1', '{"op":"insert"}');
    await settle();

    expect(seen).toEqual(['x.change.posts.org-1={"op":"insert"}']);
    await publisher.close();
    await subscriber.close();
  });

  test('subject matching is the server\'s: ">" takes the tail, "*" takes one token', async () => {
    const harness = bus();
    const transport = harness.transport();
    const wide: string[] = [];
    const narrow: string[] = [];

    await transport.subscribe('x.change.>', (payload) => wide.push(payload));
    await transport.subscribe('x.change.*', (payload) => narrow.push(payload));
    await transport.publish('x.change.posts', 'one');
    await transport.publish('x.change.posts.org-1', 'two');
    await settle();

    expect(wide).toEqual(['one', 'two']);
    expect(narrow).toEqual(['one']);
    await transport.close();
  });

  test('unsubscribe stops delivery', async () => {
    const harness = bus();
    const transport = harness.transport();
    const seen: string[] = [];

    const subscription = await transport.subscribe('x.change.>', (payload) => seen.push(payload));
    await transport.publish('x.change.posts', 'one');
    await settle();
    subscription.unsubscribe();
    await settle();
    await transport.publish('x.change.posts', 'two');
    await settle();

    expect(seen).toEqual(['one']);
    await transport.close();
  });

  test('a throwing subscriber is reported, and the other subscribers still get the change', async () => {
    const harness = bus();
    const reported: unknown[] = [];
    const transport = harness.transport({ onError: (error) => reported.push(error) });
    const seen: string[] = [];

    await transport.subscribe('x.change.>', () => {
      throw new Error('subscriber blew up');
    });
    await transport.subscribe('x.change.>', (payload) => seen.push(payload));
    await transport.publish('x.change.posts', 'one');
    await settle();

    expect(reported).toHaveLength(1);
    expect(seen).toEqual(['one']);
    await transport.close();
  });

  test('a bus restart re-dials and re-subscribes without the caller doing anything', async () => {
    const harness = bus();
    const transport = harness.transport();
    const seen: string[] = [];
    await transport.subscribe('x.change.>', (payload) => seen.push(payload));
    await transport.publish('x.change.posts', 'before');
    await settle();

    harness.server.dropAll();
    await settle();
    await settle();

    expect(transport.connected).toBe(true);
    expect(harness.dials()).toBe(2);
    await transport.publish('x.change.posts', 'after');
    await settle();
    expect(seen).toEqual(['before', 'after']);
    await transport.close();
  });

  test('presence survives the restart: the KV bucket outlives the connection', async () => {
    const harness = bus();
    const transport = harness.transport();
    await transport.subscribe('x.change.>', () => undefined);
    await transport.shared.put('presence.room', 'm1', 'alice', 30_000);

    harness.server.dropAll();
    await settle();
    await settle();

    expect((await transport.shared.entries('presence.room')).map((entry) => entry.value)).toEqual([
      'alice',
    ]);
    await transport.close();
  });

  test('a bus that never answers fails after the retry budget, not forever', async () => {
    const attempts: number[] = [];
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      maxReconnectAttempts: 3,
      sleep: async () => undefined,
      rng: () => 0.5,
      open: () => {
        attempts.push(1);
        return Promise.reject(
          new (class extends Error {
            override name = 'refused';
          })('connection refused'),
        );
      },
    });

    const error = await caught(transport.connect());

    expect(attempts).toHaveLength(4);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    await transport.close();
  });

  test('a server too old for the KV bucket fails on the first dial, not after the budget', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const server = new FakeNatsServer({ clock, version: '2.10.29' });
    let dials = 0;
    let sleeps = 0;
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      sleep: async () => {
        sleeps += 1;
      },
      open: () => {
        dials += 1;
        return Promise.resolve(server.connect());
      },
    });

    const error = await caught(transport.connect());

    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
    expect([dials, sleeps]).toEqual([1, 0]);
    await transport.close();
  });

  test('publish and subscribe on a closed transport are X_TRANSPORT_UNAVAILABLE', async () => {
    const harness = bus();
    const transport = harness.transport();
    await transport.connect();
    await transport.close();

    expect(codeOf(await caught(transport.publish('x.change.posts', 'x')))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
    expect(codeOf(await caught(transport.subscribe('x.change.>', () => undefined)))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
  });

  test('a url that is not nats:// or tls:// is refused at construction', () => {
    let error: unknown;
    try {
      new NatsTransport({ url: 'redis://bus.test:6379', bucket: 'x-test' });
    } catch (thrown) {
      error = thrown;
    }

    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
  });
});
