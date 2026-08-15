// The selector is the only thing standing between a `sync` container and an in-process transport
// that silently reaches nobody, so what is proven here is the decision itself: which transport,
// which bucket, and that the presence TTL the registry will be given is the one the bucket honours.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { InProcessTransport } from './fanout';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';
import { NatsTransport } from './nats-transport';
import {
  DEFAULT_PRESENCE_BUCKET,
  DEFAULT_PRESENCE_TTL_MS,
  selectTransport,
  TRANSPORT_ENV_KEYS,
} from './transport-env';

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
    selection: selectTransport(env, { clock: frozenClock(0), connect: fakeNatsConnect(broker) }),
  };
}

describe('selectTransport', () => {
  test('an unset NATS_URL is the in-process transport, and says what would change it', () => {
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

  test('NATS_URL selects the bus, and reports the key rather than the credential', () => {
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
      { presenceTtlMs: 120_000, clock: frozenClock(0), connect: fakeNatsConnect(broker) },
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

  test('the keys it reads are exactly these', () => {
    expect([...TRANSPORT_ENV_KEYS]).toEqual(['NATS_URL', 'NATS_KV_BUCKET']);
  });
});
