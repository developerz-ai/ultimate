// Tests for the one recovery the library does not own: a client CLOSED FOR GOOD once its reconnect
// budget is spent. Until 2026-10 `#ensure` kept handing that dead client out, so every publish and
// subscribe was X_TRANSPORT_UNAVAILABLE until somebody restarted the pod. The stub connect below
// wraps the fake bus and can close a client the way the library does — `onClosed`, never `close()`.

import { describe, expect, spyOn, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { NatsClient, NatsClientOptions, NatsConnect } from './nats-client';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';
import { NatsTransport, type NatsTransportOptions } from './nats-transport';
import type { BackoffPolicy } from './thundering-herd';

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/** Real timers: the preload freezes `Date.now()`, never `setTimeout`. */
const waitFor = async (done: () => boolean, polls = 200): Promise<void> => {
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(2);
};

const NO_WAIT: BackoffPolicy = { baseMs: 0, maxMs: 0, factor: 1, jitter: 'none' };

interface Dialled {
  readonly client: NatsClient;
  readonly options: NatsClientOptions;
}

function harness() {
  const clock = frozenClock(1_700_000_000_000);
  const broker = new FakeNatsBroker({ clock });
  const open = fakeNatsConnect(broker);
  const dialled: Dialled[] = [];
  const reported: unknown[] = [];
  /** Every dial asked for, the refused ones included — `dialled` holds only the ones that landed. */
  let attempts = 0;
  const connect: NatsConnect = async (options) => {
    attempts += 1;
    const client = await open(options);
    dialled.push({ client, options });
    return client;
  };
  const transport = (overrides: Partial<NatsTransportOptions> = {}): NatsTransport =>
    new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      backoff: NO_WAIT,
      connect,
      onError: (error) => reported.push(error),
      ...overrides,
    });
  /** What the library does when its budget runs out: the connection closes, and it says so. */
  const exhaust = async (index: number): Promise<void> => {
    const dial = dialled[index];
    if (dial === undefined) expect.unreachable(`no dial #${index}`);
    await dial.client.close();
    dial.options.onClosed?.();
  };
  return { broker, dialled, reported, transport, exhaust, attempts: () => attempts };
}

describe('NatsTransport, once the library has given up on a connection', () => {
  test('re-dials on its own, and the next publish goes out on the new client', async () => {
    const bus = harness();
    const transport = bus.transport();
    await transport.connect();

    await bus.exhaust(0);
    await waitFor(() => bus.dialled.length === 2 && transport.connected);

    expect(bus.dialled).toHaveLength(2);
    expect(transport.connected).toBe(true);
    const listener = bus.broker.client();
    const seen: string[] = [];
    listener.subscribe('x.change.>', (message) =>
      seen.push(new TextDecoder().decode(message.payload)),
    );
    await transport.publish('x.change.posts', 'after');
    expect(seen).toEqual(['after']);
    await transport.close();
  });

  test('every live subscription is re-bound on the new client, exactly once', async () => {
    const bus = harness();
    const subscriber = bus.transport();
    const publisher = bus.transport({ connect: fakeNatsConnect(bus.broker) });
    const seen: string[] = [];
    const dropped: string[] = [];
    await subscriber.subscribe('x.change.>', (payload) => seen.push(payload));
    const gone = await subscriber.subscribe('x.change.>', (payload) => dropped.push(payload));
    gone.unsubscribe();
    await publisher.publish('x.change.posts', 'before');

    await bus.exhaust(0);
    await waitFor(() => subscriber.connected);
    await publisher.publish('x.change.posts', 'after');

    expect(seen).toEqual(['before', 'after']);
    expect(dropped).toEqual([]);
    await subscriber.close();
    await publisher.close();
  });

  test('a re-dial is announced to the reconnect listeners: changes were lost in the gap', async () => {
    const bus = harness();
    const transport = bus.transport();
    await transport.connect();
    let announced = 0;
    transport.onReconnect(() => {
      announced += 1;
    });

    await bus.exhaust(0);
    await waitFor(() => announced > 0);

    expect(announced).toBe(1);
    await transport.close();
  });

  test('while the bus stays down, a caller is refused at once and the re-dial backs off', async () => {
    const bus = harness();
    // 20 ms between attempts: over 100 ms a loop that spun would dial hundreds of times.
    const transport = bus.transport({
      backoff: { baseMs: 20, maxMs: 20, factor: 1, jitter: 'none' },
    });
    await transport.connect();
    bus.broker.offline = true;

    await bus.exhaust(0);
    await Bun.sleep(5);
    const before = bus.attempts();
    // Refused without a dial of its own: a request handler is never parked behind the re-dial.
    const refused = await caught(transport.publish('x.change.posts', 'lost'));
    expect(bus.attempts()).toBe(before);
    await Bun.sleep(100);

    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(transport.connected).toBe(false);
    expect(bus.attempts()).toBeGreaterThan(2);
    expect(bus.attempts()).toBeLessThan(12);
    bus.broker.offline = false;
    await waitFor(() => transport.connected, 500);
    expect(transport.connected).toBe(true);
    await transport.close();
  });

  test('close() during a re-dial stops it: nothing is dialled after the transport is closed', async () => {
    const bus = harness();
    const transport = bus.transport({
      backoff: { baseMs: 10, maxMs: 10, factor: 1, jitter: 'none' },
    });
    await transport.connect();
    bus.broker.offline = true;
    await bus.exhaust(0);
    await Bun.sleep(5);

    await transport.close();
    bus.broker.offline = false;
    await Bun.sleep(40);

    expect(bus.dialled).toHaveLength(1);
    expect(bus.broker.clients).toHaveLength(0);
  });

  test('close() cuts a backoff wait short rather than leaving its timer armed', async () => {
    const bus = harness();
    // An hour: only `close()` can end this wait inside the test.
    const transport = bus.transport({
      backoff: { baseMs: 3_600_000, maxMs: 3_600_000, factor: 1, jitter: 'none' },
    });
    await transport.connect();
    bus.broker.offline = true;
    await bus.exhaust(0);
    await Bun.sleep(5);
    const cleared = spyOn(globalThis, 'clearTimeout');

    try {
      await transport.close();
      expect(cleared).toHaveBeenCalled();
    } finally {
      cleared.mockRestore();
    }
  });

  test('our own close() is never mistaken for a lost connection', async () => {
    const bus = harness();
    const transport = bus.transport();
    await transport.connect();
    const first = bus.dialled[0];

    await transport.close();
    first?.options.onClosed?.();
    await Bun.sleep(10);

    expect(bus.dialled).toHaveLength(1);
  });

  test('a subscription the new client refuses is reported coded, and the others are still bound', async () => {
    const bus = harness();
    const open = fakeNatsConnect(bus.broker);
    // Input handed to the transport: the library's raw refusal, which it must code before reporting.
    const violation = new TypeError('Permissions Violation');
    let dials = 0;
    const lost: NatsClientOptions[] = [];
    // The second client refuses one subject, as a permissions change on the server would.
    const connect: NatsConnect = async (options) => {
      dials += 1;
      lost.push(options);
      const client = await open(options);
      if (dials === 1) return client;
      return {
        version: client.version,
        get connected() {
          return client.connected;
        },
        publish: (subject, payload) => client.publish(subject, payload),
        request: (subject, payload, requested) => client.request(subject, payload, requested),
        requestMany: (subject, payload, many) => client.requestMany(subject, payload, many),
        close: () => client.close(),
        subscribe: (subject, handler) => {
          if (subject === 'x.denied') throw violation;
          return client.subscribe(subject, handler);
        },
      };
    };
    const transport = bus.transport({ connect });
    const publisher = bus.transport({ connect: fakeNatsConnect(bus.broker) });
    const seen: string[] = [];
    await transport.subscribe('x.denied', () => undefined);
    await transport.subscribe('x.allowed', (payload) => seen.push(payload));

    await bus.broker.clients[0]?.close();
    lost[0]?.onClosed?.();
    await waitFor(() => dials === 2 && seen.length === 0 && bus.reported.length >= 2);
    await publisher.publish('x.allowed', 'after');

    expect(seen).toEqual(['after']);
    const refusal = bus.reported.find((error) => String(error).includes('x.denied'));
    expect(codeOf(refusal)).toBe('X_TRANSPORT_UNAVAILABLE');
    await transport.close();
    await publisher.close();
  });

  test('a close reported by a client already replaced is ignored', async () => {
    const bus = harness();
    const transport = bus.transport();
    await transport.connect();
    await bus.exhaust(0);
    await waitFor(() => transport.connected);

    bus.dialled[0]?.options.onClosed?.();
    await Bun.sleep(10);

    expect(bus.dialled).toHaveLength(2);
    expect(transport.connected).toBe(true);
    await transport.close();
  });
});
