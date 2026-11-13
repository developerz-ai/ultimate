// The selector is the only thing standing between a `sync` container and an in-process transport
// that silently reaches nobody, so what is proven here is the decision itself: which transport,
// which bucket, and that the presence TTL the registry will be given is the one the bucket honours.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { ManualScheduler } from './client-harness-fixture';
import { InProcessTransport } from './fanout';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';
import { NatsTransport } from './nats-transport';
import {
  DEFAULT_PRESENCE_BUCKET,
  DEFAULT_PRESENCE_TTL_MS,
  selectTransport,
  TRANSPORT_ENV_KEYS,
} from './transport-env';
import { untilTurn } from './turns-fixture';

const URL = 'nats://bus.test:4222';

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

/** A selection wired to an in-memory bus, so `connect()` is a real dial with no network. */
function onBus(env: Record<string, string | undefined>): {
  broker: FakeNatsBroker;
  selection: ReturnType<typeof selectTransport>;
} {
  const broker = new FakeNatsBroker();
  return {
    broker,
    selection: selectTransport(env, {
      clock: frozenClock(0),
      connect: fakeNatsConnect(broker),
    }),
  };
}

describe('selectTransport', () => {
  test('memory with no bus url is the in-process transport, and says what would change it', () => {
    const selection = selectTransport({});

    expect(selection.transport).toBeInstanceOf(InProcessTransport);
    expect(selection.mode).toBe('embedded');
    expect(selection.detail).toContain('NATS_URL');
    // Nothing is stored on a bus, so naming a bucket would be a bucket nobody creates.
    expect(selection.bucket).toBeNull();
  });

  test('a blank NATS_URL is unset, not a url', () => {
    expect(selectTransport({ NATS_URL: '   ' }).mode).toBe('embedded');
  });

  test('nats reads the url, and reports the key rather than the credential', () => {
    const selection = selectTransport({ NATS_URL: 'nats://user:secret@bus.test:4222' });

    expect(selection.transport).toBeInstanceOf(NatsTransport);
    expect(selection.mode).toBe('external');
    expect(selection.detail).toBe('NATS_URL');
    expect(selection.detail).not.toContain('secret');
  });

  test('the bucket defaults, and NATS_KV_BUCKET names another one', () => {
    expect(selectTransport({ NATS_URL: URL }).bucket).toBe(DEFAULT_PRESENCE_BUCKET);
    expect(selectTransport({ NATS_URL: URL, NATS_KV_BUCKET: 'postly' }).bucket).toBe('postly');
  });

  test('a bucket name that cannot be a subject is refused at selection, not at first write', () => {
    const error = caught(() => selectTransport({ NATS_URL: URL, NATS_KV_BUCKET: 'x.presence' }));

    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
    expect(isUltimateError(error) ? error.fix : '').toContain('NATS_KV_BUCKET');
  });

  test('the presence TTL travels with the transport that derived the bucket age from it', () => {
    expect(selectTransport({}).presenceTtlMs).toBe(DEFAULT_PRESENCE_TTL_MS);
    expect(selectTransport({ NATS_URL: URL }, { presenceTtlMs: 5_000 }).presenceTtlMs).toBe(5_000);
  });

  test('selection is pure: constructing the bus touches no socket until connect()', async () => {
    const { broker, selection } = onBus({ NATS_URL: URL });

    expect(broker.clients).toHaveLength(0);
    await selection.connect();

    expect(broker.clients).toHaveLength(1);
    await selection.transport.close();
  });

  test('connect() creates the KV bucket presence needs, under the selected name', async () => {
    const { broker, selection } = onBus({ NATS_URL: URL, NATS_KV_BUCKET: 'postly' });
    await selection.connect();

    // The whole point of naming the bucket: two apps on one cluster keep separate presence.
    expect(broker.streamConfig('KV_postly')).toBeDefined();
    expect(broker.streamConfig(`KV_${DEFAULT_PRESENCE_BUCKET}`)).toBeUndefined();
    await selection.transport.close();
  });

  test('the bucket the bus creates outlives the TTL the registry will be given', async () => {
    // Above the bucket's own one-minute floor on purpose: at the default the floor alone would
    // satisfy this, and a TTL that never reached the transport would still read as correct.
    const broker = new FakeNatsBroker();
    const selection = selectTransport(
      { NATS_URL: URL },
      {
        presenceTtlMs: 120_000,
        clock: frozenClock(0),
        connect: fakeNatsConnect(broker),
      },
    );
    await selection.connect();

    // Nanoseconds, and never below the presence TTL: a bucket that aged out first would drop a
    // member the registry still counts as present, with no leave and nothing to read.
    const maxAge = Number(broker.streamConfig(`KV_${DEFAULT_PRESENCE_BUCKET}`)?.['max_age'] ?? 0);
    expect(maxAge).toBeGreaterThanOrEqual(selection.presenceTtlMs * 1_000_000);
    await selection.transport.close();
  });

  test('an embedded connect() resolves: there is nothing to reach', async () => {
    await selectTransport({}).connect();
  });

  // The env IS the bus since 31.0.0: no config key to agree with, so no mismatch to refuse. Any
  // other variable is not read — an app naming its own is `transport` in its runtime.ts.
  test('only NATS_URL selects NATS; another variable selects nothing', () => {
    expect(selectTransport({ BUS_URL: URL }).mode).toBe('embedded');
    expect(selectTransport({ NATS_URL: URL }).mode).toBe('external');
  });

  test('the in-process detail names both ways off it, and no config key', () => {
    const { detail } = selectTransport({});
    expect(detail).toContain('NATS_URL');
    expect(detail).toContain('apps/<app>/runtime.ts');
    expect(detail).not.toContain('realtime.transport');
  });

  // What the process DOES with the bus decides whether its boot waits for it. Until 2026-10 every
  // role awaited the dial and the JetStream bucket, so a web pod restarting while NATS was down
  // never served a page — for a bus it only publishes "re-read" events to.
  test("use: 'publish' connects in the background: connect() resolves with the bus down", async () => {
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const timers = new ManualScheduler();
    const selection = selectTransport(
      { NATS_URL: URL },
      {
        use: 'publish',
        clock: frozenClock(0),
        connect: fakeNatsConnect(broker),
        backoff: { base: 2, max: 2, factor: 1, jitter: 'none' },
        scheduler: timers.schedule,
        onError: () => undefined,
      },
    );

    await selection.connect();
    expect(selection.use).toBe('publish');
    expect(selection.state()).toBe('connecting');
    const refused = await selection.transport.publish('x.channel.feed', '{}').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');

    // The background dial was refused and is parked on its backoff, on the scheduler handed in.
    await untilTurn(() => timers.pending !== null, 'the refused dial armed its backoff');
    expect(timers.pending).toBe(2);
    broker.offline = false;
    timers.fire();
    await untilTurn(() => selection.state() === 'up', 'the dial after the bus came back');
    expect(selection.state()).toBe('up');
    // A publisher never reads presence, so it asks JetStream for nothing.
    expect(broker.streams).toEqual([]);
    await selection.transport.close();
  });

  test("use: 'feed' awaits the dial and creates no bucket: a replicator serves no presence", async () => {
    const broker = new FakeNatsBroker();
    const selection = selectTransport(
      { NATS_URL: URL },
      {
        use: 'feed',
        clock: frozenClock(0),
        connect: fakeNatsConnect(broker),
      },
    );
    await selection.connect();

    expect(selection.state()).toBe('up');
    expect(broker.streams).toEqual([]);
    await selection.transport.close();
  });

  test("use: 'sockets' is the default and stays a hard dependency, refused within its wait", async () => {
    const broker = new FakeNatsBroker();
    const hung = Promise.withResolvers<never>();
    const selection = selectTransport(
      { NATS_URL: URL },
      {
        clock: frozenClock(0),
        connect: () => hung.promise,
        connectWithinMs: 30,
      },
    );
    expect(selection.use).toBe('sockets');

    const refused = await selection.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(codeOf(refused)).toBe('X_TRANSPORT_UNAVAILABLE');
    const said = isUltimateError(refused) ? `${refused.cause} | ${refused.fix}` : '';
    expect(said).toContain('within 30ms');
    // The variable to check, what this process needs it for, and which roles do not.
    expect(said).toContain('NATS_URL');
    expect(said).toContain('serves sockets');
    expect(said).not.toContain('bus.test:4222/');
    expect(broker.clients).toHaveLength(0);
    await selection.transport.close();
  });

  test('the in-process bus is always up, whatever the use', async () => {
    const selection = selectTransport({}, { use: 'publish' });
    await selection.connect();
    expect(selection.state()).toBe('up');
  });

  test('the keys it reads are exactly these', () => {
    expect([...TRANSPORT_ENV_KEYS]).toEqual(['NATS_URL', 'NATS_KV_BUCKET']);
  });
});
