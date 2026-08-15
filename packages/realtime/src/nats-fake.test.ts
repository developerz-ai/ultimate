// Tests for the in-memory bus itself. Every other NATS test trusts this fake to behave like a
// server, so the semantics it claims — subject routing, a subscription that survives a drop, KV
// history of one, expiry on the injected clock, a terminated batch — are proved here rather than
// assumed there. The live test against a real nats-server is what proves these claims are honest.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { NatsClient, NatsHeaders, NatsMessage } from './nats-client';
import { FakeNatsBroker, fakeNatsConnect } from './nats-fake';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (text: string): Uint8Array => encoder.encode(text);
const payloadOf = (message: NatsMessage): string => decoder.decode(message.payload);
const bodyOf = (message: NatsMessage): Record<string, unknown> =>
  JSON.parse(payloadOf(message)) as Record<string, unknown>;

const STREAM = 'KV_x-test';
const SUBJECTS = ['$KV.x-test.>'];

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

const bucket = (client: NatsClient, config: Record<string, unknown> = {}): Promise<NatsMessage> =>
  client.request(
    `$JS.API.STREAM.CREATE.${STREAM}`,
    bytes(
      JSON.stringify({
        name: STREAM,
        subjects: SUBJECTS,
        max_msgs_per_subject: 1,
        allow_msg_ttl: true,
        ...config,
      }),
    ),
  );

const put = (
  client: NatsClient,
  key: string,
  value: string,
  headers?: NatsHeaders,
): Promise<NatsMessage> =>
  client.request(`$KV.x-test.${key}`, bytes(value), { headers: headers ?? undefined });

const get = (client: NatsClient, key: string): Promise<NatsMessage> =>
  client.request(`$JS.API.DIRECT.GET.${STREAM}.$KV.x-test.${key}`, new Uint8Array(0));

const lastOf = (
  client: NatsClient,
  filter: string,
  options: { batch?: number; until?: (message: NatsMessage) => boolean } = {},
): Promise<readonly NatsMessage[]> =>
  client.requestMany(
    `$JS.API.DIRECT.GET.${STREAM}`,
    bytes(JSON.stringify({ multi_last: [`$KV.x-test.${filter}`], batch: options.batch ?? 1_000 })),
    { until: options.until ?? (() => false) },
  );

describe('core routing', () => {
  test('a publish on one client reaches every other client subscribed to the subject', () => {
    const broker = new FakeNatsBroker();
    const [one, two] = [broker.client(), broker.client()];
    const seen: string[] = [];
    two.subscribe('room.a', (message) => seen.push(payloadOf(message)));

    one.publish('room.a', bytes('hello'));
    one.publish('room.b', bytes('elsewhere'));

    expect(seen).toEqual(['hello']);
    expect(broker.clients).toHaveLength(2);
  });

  test('a wildcard subscription follows NATS token rules, and an unsubscribe stops delivery', () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    const single: string[] = [];
    const trailing: string[] = [];
    client.subscribe('room.*.cursor', (message) => single.push(message.subject));
    const tail = client.subscribe('room.>', (message) => trailing.push(message.subject));

    client.publish('room.a.cursor', bytes('1'));
    client.publish('room.a.b.cursor', bytes('2'));
    tail.unsubscribe();
    client.publish('room.c.cursor', bytes('3'));

    expect(single).toEqual(['room.a.cursor', 'room.c.cursor']);
    expect(trailing).toEqual(['room.a.cursor', 'room.a.b.cursor']);
  });

  test('a subscription survives a drop and restore: a reconnect re-establishes it, not the caller', () => {
    const broker = new FakeNatsBroker();
    const errors: unknown[] = [];
    let reconnects = 0;
    const client = broker.client({
      url: 'nats://fake.test:4222',
      onError: (error) => errors.push(error),
      onReconnect: () => {
        reconnects += 1;
      },
    });
    const seen: string[] = [];
    client.subscribe('room.a', (message) => seen.push(payloadOf(message)));

    broker.drop();
    expect(client.connected).toBe(false);
    expect(thrown(() => client.publish('room.a', bytes('lost')))).toBeUndefined();
    broker.restore();
    client.publish('room.a', bytes('kept'));

    expect(seen).toEqual(['kept']);
    expect(codeOf(errors[0])).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(reconnects).toBe(1);
    expect(client.connected).toBe(true);
  });

  test('a closed client refuses every kind of work, and closing twice is a no-op', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();

    await client.close();
    await client.close();

    expect(client.connected).toBe(false);
    expect(codeOf(thrown(() => client.publish('room.a', bytes('x'))))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
    expect(codeOf(thrown(() => client.subscribe('room.a', () => undefined)))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
    expect(codeOf(await caught(get(client, 'a')))).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(broker.clients).toEqual([]);
  });
});

describe('streams', () => {
  test('info answers 404 until the stream is created, and the broker lists it once', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    const before = await client.request(`$JS.API.STREAM.INFO.${STREAM}`, new Uint8Array(0));

    await bucket(client);
    await bucket(client);
    const after = await client.request(`$JS.API.STREAM.INFO.${STREAM}`, new Uint8Array(0));

    expect(bodyOf(before)['error']).toMatchObject({ code: 404, err_code: 10_059 });
    expect(bodyOf(after)['config']).toEqual({ name: STREAM });
    expect(broker.streams).toEqual([STREAM]);
    expect(broker.streamConfig(STREAM)?.['max_msgs_per_subject']).toBe(1);
  });

  test('the same name over different subjects is refused, as a real server refuses it', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    await bucket(client);

    const reply = await bucket(client, { subjects: ['$KV.other.>'] });

    expect(bodyOf(reply)['error']).toMatchObject({ code: 400, err_code: 10_065 });
    expect(broker.streamConfig(STREAM)?.['subjects']).toEqual(SUBJECTS);
  });

  test('streamConfig hands back the create body verbatim, and nothing for a stream nobody made', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    await bucket(client, { max_age: 60_000 * 1_000_000, discard: 'new' });

    const config = broker.streamConfig(STREAM);

    expect(config).toEqual({
      name: STREAM,
      subjects: SUBJECTS,
      max_msgs_per_subject: 1,
      allow_msg_ttl: true,
      max_age: 60_000 * 1_000_000,
      discard: 'new',
    });
    expect(broker.streamConfig('KV_nothing')).toBeUndefined();
  });

  test('forget() is a node that came back empty: no streams, no messages, the same clients', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    await bucket(client);
    await put(client, 'a.b', 'value');
    const seen: string[] = [];
    client.subscribe('room.a', (message) => seen.push(payloadOf(message)));

    broker.forget();

    expect(broker.streams).toEqual([]);
    expect((await get(client, 'a.b')).status).toBe(404);
    expect(bodyOf(await put(client, 'a.b', 'again'))['error']).toMatchObject({ code: 503 });
    client.publish('room.a', bytes('still routed'));
    expect(seen).toEqual(['still routed']);
    expect(broker.clients).toEqual([client]);
  });

  test('a write no stream covers is answered "no responders", never silently stored', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();

    const reply = await put(client, 'a.b', 'value');

    expect(bodyOf(reply)['error']).toMatchObject({ code: 503 });
    expect((await get(client, 'a.b')).status).toBe(404);
  });
});

describe('kv storage', () => {
  test('history of one: a second write replaces the first, and the read carries the write time', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const broker = new FakeNatsBroker({ clock });
    const client = broker.client();
    await bucket(client);

    await put(client, 'a.b', 'first');
    clock.advance(1_000);
    await put(client, 'a.b', 'second');

    const reply = await get(client, 'a.b');
    expect(payloadOf(reply)).toBe('second');
    expect(reply.status).toBe(0);
    expect(reply.header('nats-subject')).toBe('$KV.x-test.a.b');
    expect(Date.parse(reply.header('Nats-Time-Stamp') ?? '')).toBe(1_700_000_001_000);
    expect(await lastOf(client, '*.*', { until: (m) => m.status !== 0 })).toHaveLength(1);
  });

  test('a write header the KV layer reads comes back on the read', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    await bucket(client);

    await put(client, 'a.b', '', new Map([['KV-Operation', 'DEL']]));

    const reply = await get(client, 'a.b');
    expect(reply.header('kv-operation')).toBe('DEL');
    expect(reply.header('KV-OPERATION')).toBe('DEL');
    expect(reply.header('nats-sequence')).toBe('1');
  });

  test('a per-message TTL expires on the injected clock, with nobody sweeping it', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const broker = new FakeNatsBroker({ clock });
    const client = broker.client();
    await bucket(client);
    await put(client, 'a.b', 'value', new Map([['Nats-TTL', '10']]));

    clock.advance(9_999);
    expect((await get(client, 'a.b')).status).toBe(0);
    clock.advance(2);

    expect((await get(client, 'a.b')).status).toBe(404);
    expect(await lastOf(client, '*.*', { until: (m) => m.status !== 0 })).toEqual([]);
  });

  test("max_age is the stream's own ceiling over a message that asked for no TTL", async () => {
    const clock = frozenClock(1_700_000_000_000);
    const broker = new FakeNatsBroker({ clock });
    const client = broker.client();
    await bucket(client, { max_age: 5_000 * 1_000_000 });
    await put(client, 'a.b', 'value');

    clock.advance(5_001);

    expect((await get(client, 'a.b')).status).toBe(404);
  });
});

describe('batch direct get', () => {
  test('multi_last answers current values under the filter and terminates on 204', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    await bucket(client);
    await put(client, 'set.one', '1');
    await put(client, 'set.two', '2');
    await put(client, 'set.one', '1b');
    await put(client, 'other.three', '3');

    const replies = await lastOf(client, 'set.*');

    expect(replies.map(payloadOf)).toEqual(['2', '1b', '']);
    expect(replies.at(-1)?.status).toBe(204);
  });

  test('a filter nothing matches terminates on 404, never a hang', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    await bucket(client);

    const replies = await lastOf(client, 'nothing.*');

    expect(replies).toHaveLength(1);
    expect(replies[0]?.status).toBe(404);
  });

  test('until excludes the message it accepts, and batch caps what comes before it', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    await bucket(client);
    await put(client, 'set.one', '1');
    await put(client, 'set.two', '2');
    await put(client, 'set.three', '3');

    const all = await lastOf(client, 'set.*', { until: (message) => message.status !== 0 });
    const capped = await lastOf(client, 'set.*', {
      batch: 2,
      until: (message) => message.status !== 0,
    });

    expect(all.map(payloadOf)).toEqual(['1', '2', '3']);
    expect(capped.map(payloadOf)).toEqual(['1', '2']);
  });
});

describe('failure injection', () => {
  test('fail() refuses the next request whose subject holds the needle, and only that many', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();
    broker.fail('STREAM.CREATE', 2);

    expect(codeOf(await caught(bucket(client)))).toBe('X_TRANSPORT_UNAVAILABLE');
    expect(codeOf(await caught(bucket(client)))).toBe('X_TRANSPORT_UNAVAILABLE');
    await bucket(client);

    expect(broker.streams).toEqual([STREAM]);
  });

  test('a subject nothing answers is unavailable rather than an empty reply', async () => {
    const broker = new FakeNatsBroker();
    const client = broker.client();

    expect(codeOf(await caught(client.request('nobody.here', new Uint8Array(0))))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
  });

  test('offline refuses the dial, and a dial that lands shares the broker', async () => {
    const broker = new FakeNatsBroker({ version: '2.12.0' });
    const connect = fakeNatsConnect(broker);
    broker.offline = true;

    expect(codeOf(await caught(connect({ url: 'nats://fake.test:4222' })))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
    broker.offline = false;
    const client = await connect({ url: 'nats://fake.test:4222' });
    const seen: string[] = [];
    broker.client().subscribe('room.a', (message) => seen.push(payloadOf(message)));
    client.publish('room.a', bytes('shared'));

    expect(seen).toEqual(['shared']);
    expect(client.version).toBe('2.12.0');
  });
});
