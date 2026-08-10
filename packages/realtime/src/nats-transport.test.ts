// Tests for the production transport: cross-node fanout, and the reconnect that re-establishes
// every subscription. Subscriptions are held as intent, so the interesting case is a bus that
// disappears mid-flight — after it returns, a publish must still reach a subscriber that never
// re-subscribed itself. Sleeps are injected so the backoff costs no wall-clock time.

import { describe, expect, spyOn, test } from 'bun:test';
import { frozenClock, isUltimateError, logger } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import { FakeNatsServer } from './nats-fake';
import type { NatsStream } from './nats-socket';
import { NatsTransport, type NatsTransportOptions } from './nats-transport';

const decoder = new TextDecoder();

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

/** A socket that refuses one control line — a dial failing after the connection is already up. */
const refusing = (stream: NatsStream, needle: string): NatsStream => ({
  ...stream,
  write: async (bytes) => {
    if (decoder.decode(bytes).includes(needle)) {
      throw new TransportUnavailableError({
        transport: 'nats',
        reason: `the socket refused "${needle}"`,
      });
    }
    await stream.write(bytes);
  },
});

/** A socket the server tears down as one control line goes out: a connection lost mid-dial. */
const droppingOn = (stream: NatsStream, needle: string): NatsStream => ({
  ...stream,
  write: async (bytes) => {
    if (decoder.decode(bytes).includes(needle)) {
      stream.close();
      return;
    }
    await stream.write(bytes);
  },
});

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
  /** Whatever the transport reported in the background. Collected so it never reaches the log. */
  readonly reported: readonly unknown[];
  readonly transport: (overrides?: Partial<NatsTransportOptions>) => NatsTransport;
  readonly dials: () => number;
}

function bus(): Bus {
  const clock = frozenClock(1_700_000_000_000);
  const server = new FakeNatsServer({ clock });
  const reported: unknown[] = [];
  let dials = 0;
  return {
    server,
    reported,
    dials: () => dials,
    transport: (overrides = {}) =>
      new NatsTransport({
        url: 'nats://bus.test:4222',
        bucket: 'x-test',
        clock,
        rng: () => 0.5,
        sleep: async () => undefined,
        onError: (error) => reported.push(error),
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
      throw new TransportUnavailableError({ transport: 'test', reason: 'the subscriber blew up' });
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
    // The dial got as far as a live socket before the bucket check refused the server: a rejected
    // connect() that still holds one open is a leak, and `connected` would be answering for it.
    expect(server.connections).toBe(0);
    expect(transport.connected).toBe(false);
    await transport.close();
  });

  test('a dial that fails after the socket is up closes it, rather than leaking one per retry', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const server = new FakeNatsServer({ clock });
    let dials = 0;
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      sleep: async () => undefined,
      onError: () => undefined,
      open: () => {
        dials += 1;
        const stream = server.connect();
        return Promise.resolve(dials <= 2 ? refusing(stream, '$JS.API.STREAM.INFO') : stream);
      },
    });

    await transport.connect();

    expect(dials).toBe(3);
    expect(server.connections).toBe(1);
    await transport.close();
    expect(server.connections).toBe(0);
  });

  test('a dial that fails mid-rebind leaves no second subscription delivering the same change', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const server = new FakeNatsServer({ clock });
    const seen: string[] = [];
    let dials = 0;
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      sleep: async () => undefined,
      onError: () => undefined,
      // The dial after the restart binds `alpha` and is then refused `beta`: a half-done rebind.
      open: () => {
        dials += 1;
        const stream = server.connect();
        return Promise.resolve(dials === 2 ? refusing(stream, 'SUB x.change.beta') : stream);
      },
    });
    await transport.subscribe('x.change.alpha', (payload) => seen.push(payload));
    await transport.subscribe('x.change.beta', () => undefined);

    server.dropAll();
    await settle();
    await settle();
    await transport.publish('x.change.alpha', 'once');
    await settle();

    expect(seen).toEqual(['once']);
    expect(dials).toBe(3);
    expect(server.connections).toBe(1);
    await transport.close();
  });

  test('a connection lost mid-dial is not reported as the live one going down', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const server = new FakeNatsServer({ clock });
    const reported: unknown[] = [];
    const seen: string[] = [];
    let dials = 0;
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      sleep: async () => undefined,
      onError: (error) => reported.push(error),
      // The retry's socket dies while the bucket check is in flight. That connection was never
      // published, so the dial owns its failure — reporting it again is a loss that never was.
      open: () => {
        dials += 1;
        const stream = server.connect();
        return Promise.resolve(dials === 2 ? droppingOn(stream, '$JS.API.STREAM.INFO') : stream);
      },
    });
    await transport.subscribe('x.change.>', (payload) => seen.push(payload));

    server.dropAll();
    await settle();
    await settle();
    await transport.publish('x.change.posts', 'after');
    await settle();

    expect(reported).toHaveLength(1);
    expect(seen).toEqual(['after']);
    expect(transport.connected).toBe(true);
    expect(server.connections).toBe(1);
    await transport.close();
  });

  test('a dial that lands after close() closes its connection instead of publishing it', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const server = new FakeNatsServer({ clock });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      sleep: async () => undefined,
      onError: () => undefined,
      open: async () => {
        await gate;
        return server.connect();
      },
    });

    const dialing = caught(transport.connect());
    await transport.close();
    release();

    expect(codeOf(await dialing)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(transport.connected).toBe(false);
    expect(server.connections).toBe(0);
  });

  test('a background failure with no onError reaches the log rather than silence', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const server = new FakeNatsServer({ clock });
    const transport = new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      sleep: async () => undefined,
      open: () => Promise.resolve(server.connect()),
    });
    const logged = spyOn(logger, 'error').mockImplementation(() => undefined);

    try {
      await transport.subscribe('x.change.>', () => {
        throw new TransportUnavailableError({
          transport: 'test',
          reason: 'the subscriber blew up',
        });
      });
      await transport.publish('x.change.posts', 'one');
      await settle();

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]?.[0]).toBe('nats transport error');
    } finally {
      logged.mockRestore();
      await transport.close();
    }
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
