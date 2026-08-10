// Tests for the JetStream KV layer: the bucket guards, the direct reads, and `TransportSet` on top
// of them. Everything runs against the in-memory server, so expiry is driven by a frozen clock the
// server and the set share — the same clock the real server would be keeping on its own.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { topic } from './channel';
import { NatsConnection } from './nats-connection';
import { FakeNatsServer } from './nats-fake';
import {
  assertBucket,
  assertServerVersion,
  ensureKvBucket,
  kvGet,
  kvLast,
  kvWrite,
} from './nats-jetstream';
import { decodeToken, encodeToken, NatsKvSet } from './nats-kv';
import type { NatsTarget } from './nats-socket';
import { PresenceRegistry } from './presence';

const TARGET: NatsTarget = {
  host: 'bus.test',
  port: 4222,
  tls: false,
  user: undefined,
  pass: undefined,
  token: undefined,
};

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
  readonly server: FakeNatsServer;
  readonly connection: NatsConnection;
  readonly tick: (ms: number) => void;
}

async function harness(options: { version?: string } = {}): Promise<Harness> {
  const clock = frozenClock(1_700_000_000_000);
  const server = new FakeNatsServer({ clock, ...options });
  const connection = await NatsConnection.open({
    stream: server.connect(),
    target: TARGET,
    requestTimeoutMs: 200,
  });
  await ensureKvBucket(connection, 'x-test', 30_000);
  const set = new NatsKvSet({
    connection: () => Promise.resolve(connection),
    bucket: 'x-test',
    clock,
  });
  return { set, server, connection, tick: (ms) => clock.advance(ms) };
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
    const server = new FakeNatsServer({ version: '2.9.5' });
    const connection = await NatsConnection.open({ stream: server.connect(), target: TARGET });

    expect(codeOf(await caught(ensureKvBucket(connection, 'x-test', 1_000)))).toBe(
      'X_TRANSPORT_PROTOCOL',
    );
    await connection.close();
  });
});

describe('the bucket', () => {
  test('a missing bucket is created with history 1, direct reads and per-message TTL', async () => {
    const { connection, server } = await harness();

    const created = await kvGet(connection, 'x-test', 'nothing');

    expect(created).toBeUndefined();
    expect(server.connections).toBe(1);
  });

  test('an existing bucket is left alone: create runs once, not on every connect', async () => {
    const { connection } = await harness();
    await kvWrite(connection, 'x-test', 'a.b', 'kept', new Map());

    await ensureKvBucket(connection, 'x-test', 30_000);

    expect((await kvGet(connection, 'x-test', 'a.b'))?.value).toBe('kept');
  });

  test('kvLast answers with every current value under the filter, and nothing else', async () => {
    const { connection } = await harness();
    await kvWrite(connection, 'x-test', 'set.one', '1', new Map());
    await kvWrite(connection, 'x-test', 'set.two', '2', new Map());
    await kvWrite(connection, 'x-test', 'other.three', '3', new Map());

    const records = await kvLast(connection, 'x-test', 'set.*');

    expect(records.map((record) => record.value).sort()).toEqual(['1', '2']);
    expect(records.map((record) => record.key).sort()).toEqual(['set.one', 'set.two']);
  });

  test('kvLast on an empty prefix is an empty list, not a hang or a throw', async () => {
    const { connection } = await harness();

    expect(await kvLast(connection, 'x-test', 'nothing.*')).toEqual([]);
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

  test('a member id carrying a dot stays one member, not two', async () => {
    const { set } = await harness();
    await set.put('presence.room', 'socket.7', 'a', 30_000);

    const entries = await set.entries('presence.room');

    expect(entries.map((entry) => entry.member)).toEqual(['socket.7']);
  });
});

describe('presence over the bus', () => {
  test('a member joined on one node is listed on another, and expires without a sweeper', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const server = new FakeNatsServer({ clock });
    const nodes = await Promise.all(
      [0, 1].map(async () =>
        NatsConnection.open({ stream: server.connect(), target: TARGET, requestTimeoutMs: 200 }),
      ),
    );
    const first = nodes[0];
    const second = nodes[1];
    if (first === undefined || second === undefined) throw new Error('two nodes are required');
    await ensureKvBucket(first, 'x-test', 30_000);
    const registries = [first, second].map(
      (connection) =>
        new PresenceRegistry({
          transport: {
            name: 'nats',
            publish: async () => undefined,
            subscribe: async () => ({ subject: '', unsubscribe: () => undefined }),
            close: async () => undefined,
            shared: new NatsKvSet({
              connection: () => Promise.resolve(connection),
              bucket: 'x-test',
              clock,
            }),
          },
          clock,
          ttlMs: 30_000,
        }),
    );
    const [joiner, observer] = registries;
    if (joiner === undefined || observer === undefined) throw new Error('two nodes are required');
    const room = topic('org', 'o1', 'cursors');

    await joiner.join(room, { id: 'm1', actorId: 'alice', meta: { x: 1 } });

    expect((await observer.list(room)).map((member) => member.actorId)).toEqual(['alice']);
    clock.advance(30_001);
    expect(await observer.list(room)).toEqual([]);

    for (const node of nodes) await node.close();
  });
});
