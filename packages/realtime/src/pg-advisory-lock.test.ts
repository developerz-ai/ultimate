// Drives `PgAdvisoryLock` against a fake `PgStream`, the same shape `pg-connection.test.ts` uses
// for `PgConnection` — no socket, no real server, no timers. Each test scripts a fresh session:
// trust auth, then one row answering the lock query, `t` or `f`.

import { describe, expect, test } from 'bun:test';
import { ReplicationFailedError } from './errors';
import { PgAdvisoryLock } from './pg-advisory-lock';
import { ByteReader } from './pg-bytes';
import {
  authOk,
  commandComplete,
  dataRow,
  decodeFrame,
  decodeStartup,
  errorResponse,
  FakeStream,
  readyForQuery,
} from './pg-connection-fixture';

const decoder = new TextDecoder();
const FAKE_URL = 'postgres://repluser:hunter2@localhost:5432/app';
const KEY = 'x:replicator:slot';

/** `stream.writes[index]`, narrowed — `noUncheckedIndexedAccess` makes every index optional. */
const writeAt = (stream: FakeStream, index: number): Uint8Array => {
  const bytes = stream.writes[index];
  if (bytes === undefined) expect.unreachable(`expected a client write at index ${index}`);
  return bytes;
};

/** The cstring SQL body of the `Query` message at `stream.writes[index]`. */
const sqlOf = (stream: FakeStream, index: number): string =>
  new ByteReader(decodeFrame(writeAt(stream, index)).body).cstring();

/** Trust auth: `AuthenticationOk` then `ReadyForQuery` — the cheapest handshake there is. */
const scriptHandshake = (stream: FakeStream): void => {
  stream.push(authOk(), readyForQuery());
};

/** One row answering `pg_try_advisory_lock` / `pg_advisory_unlock` — both return one bool. */
const scriptLockReply = (stream: FakeStream, value: 't' | 'f'): void => {
  stream.push(dataRow(value), commandComplete('SELECT 1'), readyForQuery());
};

const lockOver = (stream: FakeStream, key: string = KEY): PgAdvisoryLock =>
  new PgAdvisoryLock({ url: FAKE_URL, key, stream: () => Promise.resolve(stream) });

describe('constructor — key validation', () => {
  test.each([
    ['a key carrying a quote and embedded SQL', "x:replicator:'; DROP TABLE"],
    ['an empty key', ''],
  ])('%s throws X_REPLICATION_FAILED, before any connection opens', (_label, key) => {
    expect(() => new PgAdvisoryLock({ url: FAKE_URL, key })).toThrow(ReplicationFailedError);
    let error: unknown;
    try {
      new PgAdvisoryLock({ url: FAKE_URL, key });
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
  });
});

describe('tryAcquire', () => {
  test('acquires: resolves true; the query and application_name both name the lock', async () => {
    const stream = new FakeStream();
    scriptHandshake(stream);
    scriptLockReply(stream, 't');
    const lock = lockOver(stream);
    expect(await lock.tryAcquire()).toBe(true);
    const sql = sqlOf(stream, 1);
    expect(sql).toContain('pg_try_advisory_lock');
    expect(sql).toContain(KEY);
    expect(decodeStartup(writeAt(stream, 0)).params).toEqual({
      user: 'repluser',
      database: 'app',
      application_name: `ultimate-replicator-lock:${KEY}`,
    });
  });

  test('refused: a false row resolves false and closes the connection', async () => {
    const stream = new FakeStream();
    scriptHandshake(stream);
    scriptLockReply(stream, 'f');
    const lock = lockOver(stream);
    expect(await lock.tryAcquire()).toBe(false);
    expect(stream.closed).toBe(true);
    expect(decodeFrame(writeAt(stream, 2)).tag).toBe('X');
  });

  test('held: a second call on the same instance issues no second lock query', async () => {
    const stream = new FakeStream();
    scriptHandshake(stream);
    scriptLockReply(stream, 't');
    const lock = lockOver(stream);
    expect(await lock.tryAcquire()).toBe(true);
    expect(await lock.tryAcquire()).toBe(true);
    const lockQueries = stream.writes.filter((bytes) =>
      decoder.decode(bytes).includes('pg_try_advisory_lock'),
    );
    expect(lockQueries).toHaveLength(1);
  });

  test('a server errorResponse during the lock query propagates, never a false', async () => {
    const stream = new FakeStream();
    scriptHandshake(stream);
    stream.push(errorResponse({ C: '55000', M: 'could not obtain lock' }), readyForQuery());
    const lock = lockOver(stream);
    const error = await lock.tryAcquire().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect(stream.closed).toBe(true);
  });
});

describe('release', () => {
  test('writes pg_advisory_unlock and closes; a second release() writes nothing more', async () => {
    const stream = new FakeStream();
    scriptHandshake(stream);
    scriptLockReply(stream, 't');
    scriptLockReply(stream, 't'); // the pg_advisory_unlock reply
    const lock = lockOver(stream);
    expect(await lock.tryAcquire()).toBe(true);
    await lock.release();
    expect(sqlOf(stream, 2)).toContain('pg_advisory_unlock');
    expect(stream.closed).toBe(true);
    const writeCountAfterRelease = stream.writes.length;
    await lock.release();
    expect(stream.writes.length).toBe(writeCountAfterRelease);
  });

  test('before any acquire is a no-op: no connection is ever opened', async () => {
    const stream = new FakeStream();
    const lock = lockOver(stream);
    await lock.release();
    expect(stream.writes).toHaveLength(0);
    expect(stream.closed).toBe(false);
  });
});

describe('acquire, release, acquire', () => {
  test('opens a fresh connection and can acquire again', async () => {
    const first = new FakeStream();
    scriptHandshake(first);
    scriptLockReply(first, 't');
    scriptLockReply(first, 't'); // the pg_advisory_unlock reply
    const second = new FakeStream();
    scriptHandshake(second);
    scriptLockReply(second, 't');
    const streams = [first, second];
    let calls = 0;
    const lock = new PgAdvisoryLock({
      url: FAKE_URL,
      key: KEY,
      stream: () => {
        const stream = streams[calls];
        calls += 1;
        if (stream === undefined) expect.unreachable('opened more connections than scripted');
        return Promise.resolve(stream);
      },
    });
    expect(await lock.tryAcquire()).toBe(true);
    await lock.release();
    expect(first.closed).toBe(true);
    expect(await lock.tryAcquire()).toBe(true);
    expect(second.closed).toBe(false);
    expect(calls).toBe(2);
  });
});
