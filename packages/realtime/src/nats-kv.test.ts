// Tests for the JetStream KV layer: the bucket guards, the direct reads, and `TransportSet` on top
// of them. Everything runs against the in-memory broker, so expiry is driven by a frozen clock the
// broker and the set share — the same clock the real server would be keeping on its own.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { topic } from './channel';
import type { NatsClient } from './nats-client';
import { FakeNatsBroker } from './nats-fake';
import {
  assertBucket,
  assertServerVersion,
  ensureKvBucket,
  kvGet,
  kvLast,
  kvWrite,
} from './nats-jetstream';
import { decodeToken, encodeToken, NatsKvSet } from './nats-kv';
import { PresenceRegistry } from './presence';

const BUCKET = 'x-test';

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

interface Harness {
  readonly set: NatsKvSet;
  readonly broker: FakeNatsBroker;
  readonly client: NatsClient;
  readonly tick: (ms: number) => void;
}

async function harness(options: { version?: string } = {}): Promise<Harness> {
  const clock = frozenClock(1_700_000_000_000);
  const broker = new FakeNatsBroker({ clock, ...options });
  const client = broker.client();
  await ensureKvBucket(client, BUCKET, 30_000);
  const set = new NatsKvSet({ client: async () => client, bucket: BUCKET, clock });
  return { set, broker, client, tick: (ms) => clock.advance(ms) };
}

describe('guards', () => {
  test('a bucket name outside [a-zA-Z0-9_-] is refused before it reaches a subject', () => {
    for (const bad of ['x dev', 'x.dev', 'x>dev', '']) {
      expect(codeOf(thrown(() => assertBucket(bad)))).toBe('X_TRANSPORT_PROTOCOL');
    }
    expect(thrown(() => assertBucket('x-dev_1'))).toBeUndefined();
  });

  test('a server older than 2.11 is refused, and the fix names the image', () => {
    const error = thrown(() => assertServerVersion('2.10.22'));

    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
    expect(isUltimateError(error) ? error.fix : '').toContain('2.11');
    expect(thrown(() => assertServerVersion('2.11.0'))).toBeUndefined();
    expect(thrown(() => assertServerVersion('3.0.1'))).toBeUndefined();
    expect(codeOf(thrown(() => assertServerVersion('')))).toBe('X_TRANSPORT_PROTOCOL');
  });

  test('ensureKvBucket refuses to run against a server that is too old', async () => {
    const broker = new FakeNatsBroker({ version: '2.9.5' });
    const client = broker.client();

    expect(codeOf(await caught(ensureKvBucket(client, BUCKET, 1_000)))).toBe(
      'X_TRANSPORT_PROTOCOL',
    );
    expect(broker.streams).toEqual([]);
    await client.close();
  });
});

describe('the bucket', () => {
  test('a missing bucket is created with history 1, direct reads and per-message TTL', async () => {
    const { broker } = await harness();

    const config = broker.streamConfig('KV_x-test');

    expect(broker.streams).toEqual(['KV_x-test']);
    expect(config?.['subjects']).toEqual(['$KV.x-test.>']);
    expect(config?.['max_msgs_per_subject']).toBe(1);
    expect(config?.['discard']).toBe('new');
    expect(config?.['deny_delete']).toBe(true);
    expect(config?.['allow_direct']).toBe(true);
    expect(config?.['allow_msg_ttl']).toBe(true);
  });

  test('an existing bucket is left alone: create runs once, not on every connect', async () => {
    const { client, broker } = await harness();
    await kvWrite(client, BUCKET, 'a.b', 'kept', new Map());
    // A second create would be refused outright, so a green second call is proof none was sent.
    broker.fail('STREAM.CREATE', 1);

    await ensureKvBucket(client, BUCKET, 30_000);

    expect(broker.streams).toEqual(['KV_x-test']);
    expect((await kvGet(client, BUCKET, 'a.b'))?.value).toBe('kept');
  });

  test('kvGet on a key nobody wrote is undefined, never a throw', async () => {
    const { client } = await harness();

    expect(await kvGet(client, BUCKET, 'nothing')).toBeUndefined();
  });

  test('kvGet carries the tombstone marker the caller decides on', async () => {
    const { client } = await harness();
    await kvWrite(client, BUCKET, 'a.b', '', new Map([['KV-Operation', 'DEL']]));

    expect((await kvGet(client, BUCKET, 'a.b'))?.operation).toBe('DEL');
  });

  test('kvLast answers with every current value under the filter, and nothing else', async () => {
    const { client } = await harness();
    await kvWrite(client, BUCKET, 'set.one', '1', new Map());
    await kvWrite(client, BUCKET, 'set.two', '2', new Map());
    await kvWrite(client, BUCKET, 'other.three', '3', new Map());

    const records = await kvLast(client, BUCKET, 'set.*');

    expect(records.map((record) => record.value).sort()).toEqual(['1', '2']);
    expect(records.map((record) => record.key).sort()).toEqual(['set.one', 'set.two']);
  });

  test('kvLast on an empty prefix is an empty list, not a hang or a throw', async () => {
    const { client } = await harness();

    expect(await kvLast(client, BUCKET, 'nothing.*')).toEqual([]);
  });
});

describe('token encoding', () => {
  test('a key with dots, spaces and wildcards survives the round trip', () => {
    for (const raw of ['presence.org:o1:cursors', 'a b', '>', '*', 'ünïcøde', '']) {
      expect(decodeToken(encodeToken(raw))).toBe(raw);
    }
  });

  test('an encoded token carries no character a subject would split on', () => {
    expect(encodeToken('presence.org:o1:cursors')).toMatch(/^[A-Za-z0-9_-]*$/);
  });
});

describe('NatsKvSet', () => {
  test('put then entries returns the member, its value and its expiry', async () => {
    const { set } = await harness();
    await set.put('presence.room', 'm1', '{"actorId":"alice"}', 30_000);

    const entries = await set.entries('presence.room');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.member).toBe('m1');
    expect(entries[0]?.value).toBe('{"actorId":"alice"}');
    expect(entries[0]?.expiresAt).toBe(1_700_000_000_000 + 30_000);
  });

  test('a member expires on its own TTL with nobody sweeping it', async () => {
    const { set, tick } = await harness();
    await set.put('presence.room', 'm1', 'a', 10_000);

    tick(9_999);
    expect(await set.entries('presence.room')).toHaveLength(1);
    tick(2);
    expect(await set.entries('presence.room')).toHaveLength(0);
  });

  test('touch extends a live member and refuses an expired one', async () => {
    const { set, tick } = await harness();
    await set.put('presence.room', 'm1', 'a', 10_000);

    tick(5_000);
    expect(await set.touch('presence.room', 'm1', 10_000)).toBe(true);
    tick(9_000);
    expect(await set.entries('presence.room')).toHaveLength(1);
    tick(2_000);
    expect(await set.touch('presence.room', 'm1', 10_000)).toBe(false);
    expect(await set.entries('presence.room')).toHaveLength(0);
  });

  test('touch on a member that was never written is false, never a throw', async () => {
    const { set } = await harness();

    expect(await set.touch('presence.room', 'ghost', 1_000)).toBe(false);
  });

  test('drop leaves a tombstone that entries skips', async () => {
    const { set } = await harness();
    await set.put('presence.room', 'm1', 'a', 30_000);
    await set.put('presence.room', 'm2', 'b', 30_000);

    await set.drop('presence.room', 'm1');

    expect((await set.entries('presence.room')).map((entry) => entry.member)).toEqual(['m2']);
    expect(await set.touch('presence.room', 'm1', 30_000)).toBe(false);
  });

  test('two sets never see each other: one key does not leak into another', async () => {
    const { set } = await harness();
    await set.put('presence.a', 'm1', '1', 30_000);
    await set.put('presence.b', 'm2', '2', 30_000);

    expect((await set.entries('presence.a')).map((entry) => entry.member)).toEqual(['m1']);
    expect((await set.entries('presence.b')).map((entry) => entry.member)).toEqual(['m2']);
  });

  test('a key this bucket did not write is skipped, not a throw that hides every member', async () => {
    const { set, client } = await harness();
    await set.put('presence.room', 'm1', 'a', 30_000);
    // Something else's key under the same prefix: the member token is not base64url at all.
    await kvWrite(
      client,
      BUCKET,
      `${encodeToken('presence.room')}.not-a-token!`,
      JSON.stringify({ v: 'b', t: 30_000 }),
      new Map(),
    );

    const entries = await set.entries('presence.room');

    expect(entries.map((entry) => entry.member)).toEqual(['m1']);
  });

  test('a member id carrying a dot stays one member, not two', async () => {
    const { set } = await harness();
    await set.put('presence.room', 'socket.7', 'a', 30_000);

    const entries = await set.entries('presence.room');

    expect(entries.map((entry) => entry.member)).toEqual(['socket.7']);
  });

  test('a write the bus refused raises: a lost put must never read as stored', async () => {
    const { set, broker } = await harness();
    broker.fail('$KV.x-test', 1);

    expect(codeOf(await caught(set.put('presence.room', 'm1', 'a', 30_000)))).toBe(
      'X_TRANSPORT_UNAVAILABLE',
    );
    expect(await set.entries('presence.room')).toEqual([]);
  });
});

describe('presence over the bus', () => {
  test('a member joined on one node is listed on another, and expires without a sweeper', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const broker = new FakeNatsBroker({ clock });
    const nodes = [broker.client(), broker.client()];
    const [first, second] = nodes;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    await ensureKvBucket(first, BUCKET, 30_000);
    const registries = [first, second].map(
      (client) =>
        new PresenceRegistry({
          transport: {
            name: 'nats',
            publish: async () => undefined,
            subscribe: async () => ({ subject: '', unsubscribe: () => undefined }),
            close: async () => undefined,
            shared: new NatsKvSet({ client: async () => client, bucket: BUCKET, clock }),
          },
          clock,
          ttlMs: 30_000,
        }),
    );
    const [joiner, observer] = registries;
    expect(joiner).toBeDefined();
    expect(observer).toBeDefined();
    if (joiner === undefined || observer === undefined) return;
    const room = topic('org', 'o1', 'cursors');

    await joiner.join(room, { id: 'm1', actorId: 'alice', meta: { x: 1 } });

    expect((await observer.list(room)).map((member) => member.actorId)).toEqual(['alice']);
    clock.advance(30_001);
    expect(await observer.list(room)).toEqual([]);

    for (const node of nodes) await node.close();
  });
});
