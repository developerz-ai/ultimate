// NatsTransport's other ways to come up: a presence bucket made on first use, connect() bounded by
// `withinMs`, and a publish while the client is reconnecting. Split from
// nats-transport-background.test.ts, which keeps connectInBackground and the dial loop.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { ManualScheduler } from './client-harness-fixture';
import type { NatsClient, NatsConnect } from './nats-client';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';
import { NatsTransport, type NatsTransportOptions } from './nats-transport';
import type { ReconnectBackoff } from './thundering-herd';
import { untilTurn } from './turns-fixture';

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const causeOf = (value: unknown): string => (isUltimateError(value) ? value.cause : String(value));

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/**
 * Lets the dial loop's backoff run out `count` times by hand: each wait is armed (the loop is
 * parked, not spinning) and fired, and the next dial is awaited — never a wall-clock wait.
 */
async function fireBackoffs(timers: ManualScheduler, attempts: () => number, count: number) {
  for (let fired = 0; fired < count; fired += 1) {
    await untilTurn(() => timers.pending !== null, `backoff #${fired + 1} armed`);
    const before = attempts();
    timers.fire();
    await untilTurn(() => attempts() > before, `the dial after backoff #${fired + 1}`);
  }
}

const QUICK: ReconnectBackoff = { base: 5, max: 5, factor: 1, jitter: 'none' };

function harness() {
  const clock = frozenClock(1_700_000_000_000);
  const broker = new FakeNatsBroker({ clock });
  const open = fakeNatsConnect(broker);
  const reported: unknown[] = [];
  let attempts = 0;
  /** The dial loop's backoff wait: armed here, ended only by `timers.fire()` or `close()`. */
  const timers = new ManualScheduler();
  const connect: NatsConnect = async (options) => {
    attempts += 1;
    return open(options);
  };
  const transport = (overrides: Partial<NatsTransportOptions> = {}): NatsTransport =>
    new NatsTransport({
      url: 'nats://bus.test:4222',
      bucket: 'x-test',
      clock,
      rng: () => 0.5,
      backoff: QUICK,
      connect,
      scheduler: timers.schedule,
      onError: (error) => reported.push(error),
      ...overrides,
    });
  const backoffs = (count: number): Promise<void> => fireBackoffs(timers, () => attempts, count);
  return { broker, reported, timers, transport, backoffs, attempts: () => attempts };
}

describe("NatsTransport with presenceBucket: 'first-use'", () => {
  test('a publisher connects to a server with no JetStream, and creates no bucket', async () => {
    const bus = harness();
    // Every JetStream call fails, as it does on a nats-server started without `-js`.
    bus.broker.fail('$JS.API', 1_000);
    const transport = bus.transport({ presenceBucket: 'first-use' });

    await transport.connect();

    expect(transport.connected).toBe(true);
    expect(bus.broker.streams).toEqual([]);
    const seen: string[] = [];
    bus.broker.client().subscribe('x.cache.invalidate', (message) => {
      seen.push(new TextDecoder().decode(message.payload));
    });
    await transport.publish('x.cache.invalidate', '["post:1"]');
    expect(seen).toEqual(['["post:1"]']);
    await transport.close();
  });

  test('the default still asserts the bucket at the dial: a sync node needs presence to serve', async () => {
    const bus = harness();
    bus.broker.fail('$JS.API', 1_000);
    const transport = bus.transport();

    expect(codeOf(await caught(transport.connect()))).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(transport.connected).toBe(false);
    await transport.close();
  });

  test('the first use of the shared set asserts the bucket, once per client', async () => {
    const bus = harness();
    const transport = bus.transport({ presenceBucket: 'first-use' });
    await transport.connect();
    expect(bus.broker.streams).toEqual([]);

    await transport.shared.put('room', 'ada', '{}', 30_000);
    expect(bus.broker.streams).toEqual(['KV_x-test']);
    expect((await transport.shared.entries('room')).map((entry) => entry.member)).toEqual(['ada']);
    await transport.close();
  });
});

describe('NatsTransport.connect({ withinMs })', () => {
  test('a dial that does not land in time is refused, naming the server and the wait', async () => {
    const bus = harness();
    const landed = Promise.withResolvers<NatsClient>();
    const transport = bus.transport({ connect: () => landed.promise });

    const startedAt = performance.now();
    const refused = await caught(transport.connect({ withinMs: 40 }));

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(refused)).toContain('bus.test:4222');
    expect(causeOf(refused)).toContain('within 40ms');
    // No `fix` was passed, and the refusal still carries one: `TransportUnavailableError` supplies
    // its own when the caller names none (`errors.ts`), so no path leaves this code without a fix.
    expect(isUltimateError(refused) ? refused.fix : '').toBe(
      'x doctor — then check NATS_URL points at a reachable nats-server',
    );

    // The boot unwinds by closing the transport; the dial that lands afterwards is not leaked.
    await transport.close();
    landed.resolve(bus.broker.client());
    await untilTurn(() => bus.broker.clients.length === 0, 'the late client closed');
    expect(bus.broker.clients).toHaveLength(0);
  });

  test('a dial that lands in time resolves, and one the bus keeps refusing says so in the cause', async () => {
    const bus = harness();
    const up = bus.transport();
    await up.connect({ withinMs: 1_000 });
    expect(up.connected).toBe(true);
    await up.close();

    bus.broker.offline = true;
    const before = bus.attempts();
    const down = bus.transport();
    // The wait is the transport's own real timer (`landWithin`), long enough for two backoffs
    // fired by hand on any runner; the refusal is what ends it.
    const refusal = caught(down.connect({ withinMs: 250 }));
    await bus.backoffs(2);
    const refused = await refusal;
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(refused)).toContain('within 250ms');
    expect(causeOf(refused)).toContain('refused the connection');
    // Retried inside the wait, not given up on at the first refusal.
    expect(bus.attempts() - before).toBe(3);
    await down.close();
  });

  test('a bus that comes up inside the wait is a boot that succeeds', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport();
    const connecting = transport.connect({ withinMs: 2_000 });
    await bus.backoffs(1);
    bus.broker.offline = false;
    await untilTurn(() => bus.timers.pending !== null, 'the second refusal armed a backoff');
    bus.timers.fire();

    await connecting;
    expect(transport.connected).toBe(true);
    await transport.close();
  });

  test('closing the transport under the wait ends it, coded', async () => {
    const bus = harness();
    bus.broker.offline = true;
    const transport = bus.transport();
    const connecting = caught(transport.connect({ withinMs: 5_000 }));
    await untilTurn(() => bus.timers.pending !== null, 'the first refusal armed a backoff');
    await transport.close();

    expect(codeOf(await connecting)).toBe('X_TRANSPORT_UNAVAILABLE');
  });
});

describe('NatsTransport.publish while the client is reconnecting', () => {
  test('is refused at once: the library would queue it without bound and replay it late', async () => {
    const bus = harness();
    const transport = bus.transport();
    await transport.connect();
    const seen: string[] = [];
    bus.broker
      .client()
      .subscribe('x.channel.>', (message) => seen.push(new TextDecoder().decode(message.payload)));

    bus.broker.drop();
    const refused = await caught(transport.publish('x.channel.feed', 'during'));
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(causeOf(refused)).toContain('reconnecting');

    bus.broker.restore();
    await transport.publish('x.channel.feed', 'after');
    expect(seen).toEqual(['after']);
    await transport.close();
  });
});
