// Tests for the production transport: cross-node fanout, the bucket it asserts on every connect,
// and what it does with a client that drops. The wire and the reconnect belong to the library now,
// so what is proven here is the integration — the bucket, the error contract, the one dial, and the
// jitter we still hand down — never a control line or a re-bind.

import { describe, expect, spyOn, test } from 'bun:test';
import { frozenClock, isUltimateError, logger } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import type { NatsClientOptions, NatsConnect } from './nats-client';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';
import { NatsTransport, type NatsTransportOptions } from './nats-transport';
import { backoffDelay, defaultBackoff } from './thundering-herd';

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
  readonly broker: FakeNatsBroker;
  /** Whatever the transport reported in the background. Collected so it never reaches the log. */
  readonly reported: readonly unknown[];
  readonly transport: (overrides?: Partial<NatsTransportOptions>) => NatsTransport;
  /**
   * A transport with NO `onError` — the key ABSENT, not set to `undefined`. `onError` is optional,
   * so "nobody is listening" is a missing property, and `{ onError: undefined }` cannot say that
   * under `exactOptionalPropertyTypes`. This is the shape that falls back to the log.
   */
  readonly transportWithoutOnError: () => NatsTransport;
  readonly dials: () => number;
  /** What the transport handed the client as its reconnect policy, from the last dial. */
  readonly reconnectDelay: () => (() => number) | undefined;
}

function bus(options: { version?: string } = {}): Bus {
  const clock = frozenClock(1_700_000_000_000);
  const broker = new FakeNatsBroker({ clock, ...options });
  const reported: unknown[] = [];
  const open = fakeNatsConnect(broker);
  let dials = 0;
  let delay: (() => number) | undefined;
  const connect: NatsConnect = (clientOptions: NatsClientOptions) => {
    dials += 1;
    delay = clientOptions.reconnectDelay;
    return open(clientOptions);
  };
  const base = {
    url: 'nats://bus.test:4222',
    bucket: 'x-test',
    clock,
    rng: () => 0.5,
    connect,
  } satisfies Partial<NatsTransportOptions>;
  return {
    broker,
    reported,
    dials: () => dials,
    reconnectDelay: () => delay,
    transport: (overrides = {}) =>
      new NatsTransport({ ...base, onError: (error) => reported.push(error), ...overrides }),
    transportWithoutOnError: () => new NatsTransport({ ...base }),
  };
}

describe('NatsTransport', () => {
  test('connect() dials once and creates the bucket up front', async () => {
    const harness = bus();
    const transport = harness.transport();

    await transport.connect();

    expect(transport.connected).toBe(true);
    expect(harness.dials()).toBe(1);
    expect(harness.broker.streams).toEqual(['KV_x-test']);
    await transport.close();
  });

  test('callers that race the first dial share it rather than opening one connection each', async () => {
    const harness = bus();
    const transport = harness.transport();

    await Promise.all([
      transport.connect(),
      transport.publish('x.change.posts', 'one'),
      transport.subscribe('x.change.>', () => undefined),
    ]);

    expect(harness.dials()).toBe(1);
    expect(harness.broker.clients).toHaveLength(1);
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

  test('a bus restart keeps every subscription, and the caller does nothing', async () => {
    const harness = bus();
    const transport = harness.transport();
    const seen: string[] = [];
    await transport.subscribe('x.change.>', (payload) => seen.push(payload));
    await transport.publish('x.change.posts', 'before');
    await settle();

    harness.broker.drop();
    expect(transport.connected).toBe(false);
    // A caller that arrives mid-drop gets the same client back. Dialling a second one here is the
    // bug the library's own reconnect exists to prevent: it would come back alongside the one
    // already recovering, with its own copy of every subscription, and double every change.
    await transport.publish('x.change.posts', 'during');
    expect(harness.dials()).toBe(1);
    harness.broker.restore();
    await settle();

    expect(transport.connected).toBe(true);
    expect(harness.dials()).toBe(1);
    await transport.publish('x.change.posts', 'after');
    await settle();
    expect(seen).toEqual(['before', 'after']);
    await transport.close();
  });

  test('a reconnect re-asserts the bucket: the cluster behind it may never have held one', async () => {
    const harness = bus();
    const transport = harness.transport();
    await transport.connect();
    await transport.shared.put('presence.room', 'm1', 'alice', 30_000);

    // A restarted single node comes back with no bucket at all. Nothing below the transport knows
    // that a KV bucket was ever meant to exist there.
    harness.broker.drop();
    harness.broker.forget();
    harness.broker.restore();
    await settle();

    expect(harness.broker.streams).toEqual(['KV_x-test']);
    await transport.shared.put('presence.room', 'm2', 'bob', 30_000);
    expect((await transport.shared.entries('presence.room')).map((entry) => entry.value)).toEqual([
      'bob',
    ]);
    await transport.close();
  });

  test('presence survives a drop and a restore: the bucket outlives the connection', async () => {
    const harness = bus();
    const transport = harness.transport();
    await transport.subscribe('x.change.>', () => undefined);
    await transport.shared.put('presence.room', 'm1', 'alice', 30_000);

    harness.broker.drop();
    harness.broker.restore();
    await settle();

    expect((await transport.shared.entries('presence.room')).map((entry) => entry.value)).toEqual([
      'alice',
    ]);
    await transport.close();
  });

  test('the reconnect delay is our jitter policy, not the library default', async () => {
    const harness = bus();
    const transport = harness.transport();
    await transport.connect();

    const delay = harness.reconnectDelay();

    expect(delay).toBeDefined();
    // Attempt by attempt, and the spread comes from the injected rng — a cluster restart must not
    // bring every node back on the same millisecond.
    expect([delay?.(), delay?.(), delay?.()]).toEqual([
      backoffDelay(0, defaultBackoff, () => 0.5),
      backoffDelay(1, defaultBackoff, () => 0.5),
      backoffDelay(2, defaultBackoff, () => 0.5),
    ]);
    await transport.close();
  });

  test('a bus that cannot be reached fails rather than hanging', async () => {
    const harness = bus();
    harness.broker.offline = true;
    const transport = harness.transport();

    const error = await caught(transport.connect());

    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(transport.connected).toBe(false);
    await transport.close();
  });

  test('a server too old for the KV bucket fails the dial, and closes the client it opened', async () => {
    const harness = bus({ version: '2.10.29' });
    const transport = harness.transport();

    const error = await caught(transport.connect());

    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
    // The dial got as far as a live client before the bucket check refused the server: a rejected
    // connect() that still holds one open is a leak, and `connected` would be answering for it.
    expect(harness.broker.clients).toHaveLength(0);
    expect(transport.connected).toBe(false);
    await transport.close();
  });

  test('a dial that fails after the client is up closes it, rather than leaking one per retry', async () => {
    const harness = bus();
    const transport = harness.transport({ onError: () => undefined });
    harness.broker.fail('$JS.API.STREAM.INFO');

    expect(codeOf(await caught(transport.connect()))).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(harness.broker.clients).toHaveLength(0);

    // The next caller dials again: a failed attempt parks nothing, so nothing has to be reset.
    await transport.connect();
    expect(harness.dials()).toBe(2);
    expect(harness.broker.clients).toHaveLength(1);
    await transport.close();
  });

  test('a dial that lands after close() closes its client instead of publishing it', async () => {
    const harness = bus();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const open = fakeNatsConnect(harness.broker);
    const transport = harness.transport({
      onError: () => undefined,
      connect: async (options) => {
        await gate;
        return open(options);
      },
    });

    const dialing = caught(transport.connect());
    await transport.close();
    release();

    expect(codeOf(await dialing)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(transport.connected).toBe(false);
    expect(harness.broker.clients).toHaveLength(0);
  });

  test('a background failure with no onError reaches the log rather than silence', async () => {
    const harness = bus();
    const transport = harness.transportWithoutOnError();
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

  test('a connection lost in the background is reported, never swallowed', async () => {
    const harness = bus();
    const transport = harness.transport();
    await transport.connect();

    harness.broker.drop();
    await settle();

    expect(harness.reported.map((error) => codeOf(error))).toEqual(['X_TRANSPORT_UNAVAILABLE']);
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
