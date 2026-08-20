// Drives `PgConnection` against a fake `PgStream` that scripts a Postgres server by hand: startup,
// every auth method, simple query, and the CopyBoth switch. No socket, no real server, no timers.
// The server script itself lives in `pg-connection-fixture.ts`.

import { describe, expect, test } from 'bun:test';
import { ReplicationFailedError, ReplicationProtocolError } from './errors';
import { md5Password, SCRAM_SHA_256, scramNonce, scramSession } from './pg-auth';
import { ByteReader } from './pg-bytes';
import { PgConnection, type PgConnectionOptions } from './pg-connection';
import {
  authCleartext,
  authGssapi,
  authMd5,
  authOk,
  authSasl,
  authSaslContinue,
  authSaslFinal,
  backendKeyData,
  commandComplete,
  copyBothResponse,
  copyData,
  copyDoneFrame,
  dataRow,
  decodeFrame,
  decodeStartup,
  errorResponse,
  FakeStream,
  noticeResponse,
  openInCopyBoth,
  openTrusted,
  opts,
  parameterStatus,
  readyForQuery,
  rowDescriptionStub,
  START_REPLICATION_SQL,
  toBase64,
} from './pg-connection-fixture';
import { PROTOCOL_3_0 } from './pg-wire';
import type { Rng } from './thundering-herd';

/** `stream.writes[index]`, narrowed — `noUncheckedIndexedAccess` makes every index optional. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const writeAt = (stream: FakeStream, index: number): Uint8Array => {
  const bytes = stream.writes[index];
  if (bytes === undefined) expect.unreachable(`expected a client write at index ${index}`);
  return bytes;
};

// --- Tests -------------------------------------------------------------------------------------

describe('open — startup packet', () => {
  test('carries user, database, application_name, replication; omits it when unset', async () => {
    const withReplication = new FakeStream();
    await openTrusted(withReplication, { replication: 'database' });
    const packet = decodeStartup(writeAt(withReplication, 0));
    expect(packet.version).toBe(PROTOCOL_3_0);
    expect(packet.params).toEqual({
      user: 'repluser',
      database: 'app',
      application_name: 'ultimate-replicator',
      replication: 'database',
    });
    const withoutReplication = new FakeStream();
    await openTrusted(withoutReplication);
    expect(Object.keys(decodeStartup(writeAt(withoutReplication, 0)).params)).not.toContain(
      'replication',
    );
  });
});

describe('open — authentication', () => {
  test('trust auth (AuthenticationOk) resolves once ReadyForQuery arrives', async () => {
    const stream = new FakeStream();
    stream.push(
      authOk(),
      parameterStatus('server_version', '17.0'),
      backendKeyData(4242, 99),
      readyForQuery(),
    );
    const connection = await PgConnection.open(opts(stream));
    expect(connection.parameter('server_version')).toBe('17.0');
  });

  test('cleartext auth sends the password as a cstring, then completes', async () => {
    const stream = new FakeStream();
    stream.push(authCleartext(), authOk(), readyForQuery());
    await PgConnection.open(opts(stream, { password: 'sekret' }));
    const sent = decodeFrame(writeAt(stream, 1));
    expect(sent.tag).toBe('p');
    expect(new ByteReader(sent.body).cstring()).toBe('sekret');
  });

  test.each([
    ['cleartext', authCleartext(), 'a cleartext password'],
    ['md5', authMd5(new Uint8Array([1, 2, 3, 4])), 'an md5 password'],
    ['SASL', authSasl(SCRAM_SHA_256), 'a SCRAM password'],
  ])(
    '%s auth with no password throws, naming what is missing',
    async (_label, serverFrame, named) => {
      const stream = new FakeStream();
      stream.push(serverFrame);
      const error = await PgConnection.open(opts(stream)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReplicationFailedError);
      expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
      expect((error as Error).message).toContain(named);
    },
  );

  test('md5 auth sends exactly md5Password({ user, password, salt })', async () => {
    const stream = new FakeStream();
    const salt = new Uint8Array([0x9a, 0x3c, 0x1e, 0x77]);
    stream.push(authMd5(salt), authOk(), readyForQuery());
    await PgConnection.open(opts(stream, { user: 'repluser', password: 'hunter2' }));
    const sent = decodeFrame(writeAt(stream, 1));
    expect(sent.tag).toBe('p');
    expect(new ByteReader(sent.body).cstring()).toBe(
      md5Password({ user: 'repluser', password: 'hunter2', salt }),
    );
  });

  // Full end-to-end SASL success needs a real server-side SCRAM implementation to produce a
  // correct `v=`, which this module does not have (only the client role lives in pg-auth.ts). So
  // this proves the three-message shape and an exact client-final, then a wrong signature rejects.
  test('SASL sends the client-first, answers a server-first exactly, and rejects a wrong v=', async () => {
    const fixedRng: Rng = () => 0.5;
    const stream = new FakeStream();
    const clientNonce = scramNonce(fixedRng);
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const serverFirst = `r=${clientNonce}serverhalf,s=${toBase64(salt)},i=4096`;
    const wrongServerFinal = `v=${toBase64(new Uint8Array(32))}`;
    // The exact proof bytes: a second session built from the same password and nonce, fed the
    // identical server-first, computes byte-identical output — the same algorithm under test
    // independently in pg-auth.test.ts, reused here rather than re-derived.
    const reference = scramSession({ password: 'hunter2', nonce: clientNonce });
    reference.clientFirst();
    const expectedFinal = decoder.decode(await reference.clientFinal(encoder.encode(serverFirst)));
    stream.push(
      authSasl(SCRAM_SHA_256),
      authSaslContinue(encoder.encode(serverFirst)),
      authSaslFinal(encoder.encode(wrongServerFinal)),
    );
    const error = await PgConnection.open(
      opts(stream, { password: 'hunter2', rng: fixedRng }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    const initial = new ByteReader(decodeFrame(writeAt(stream, 1)).body);
    expect(initial.cstring()).toBe(SCRAM_SHA_256);
    const initialPayload = initial.take(initial.int32());
    expect(decoder.decode(initialPayload)).toBe(`n,,n=,r=${clientNonce}`);
    expect(decoder.decode(decodeFrame(writeAt(stream, 2)).body)).toBe(expectedFinal);
  });

  test('an unrecognised auth method throws X_REPLICATION_PROTOCOL, fix names scram-sha-256', async () => {
    const stream = new FakeStream();
    stream.push(authGssapi());
    const error = await PgConnection.open(opts(stream)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationProtocolError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_PROTOCOL');
    expect((error as { fix?: string }).fix).toContain('scram-sha-256');
  });

  test('an ErrorResponse between AuthenticationOk and ReadyForQuery uses the SQLSTATE fix', async () => {
    const stream = new FakeStream();
    stream.push(authOk(), errorResponse({ C: '28P01', M: 'password authentication failed' }));
    const error = await PgConnection.open(opts(stream)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect((error as { fix?: string }).fix).toContain('the server refused the credentials');
  });

  test('EOF during the handshake throws, mentioning the server closed the connection', async () => {
    const stream = new FakeStream();
    stream.end();
    const error = await PgConnection.open(opts(stream)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect((error as Error).message).toContain('closed the connection');
  });

  test('SASLContinue before any SASL offer is X_REPLICATION_PROTOCOL, fix names a pooler', async () => {
    const stream = new FakeStream();
    stream.push(authSaslContinue(encoder.encode('r=nope,s=AAAAAAAA,i=4096')));
    const error = await PgConnection.open(opts(stream, { password: 'hunter2' })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ReplicationProtocolError);
    expect((error as { fix?: string }).fix).toBe(
      'x doctor db — the SASL exchange arrived out of order; ' +
        'check for a pooler or proxy between this client and postgres',
    );
  });
});

/**
 * A failed handshake hands the caller an exception, never an object — so nothing is left holding
 * the socket unless `open` releases it. A supervisor that retries on a schedule turns a leak here
 * into one file descriptor per attempt, which is why every rejecting path is enumerated.
 */
describe('open — a failed handshake never leaks the stream', () => {
  const scripts: readonly (readonly [
    string,
    (stream: FakeStream) => void,
    Partial<PgConnectionOptions>,
  ])[] = [
    ['cleartext auth with no password', (stream) => stream.push(authCleartext()), {}],
    ['md5 auth with no password', (stream) => stream.push(authMd5(new Uint8Array(4))), {}],
    ['SASL auth with no password', (stream) => stream.push(authSasl(SCRAM_SHA_256)), {}],
    ['an auth method this client does not speak', (stream) => stream.push(authGssapi()), {}],
    [
      'a SASL offer with only the -PLUS mechanism',
      (stream) => stream.push(authSasl('SCRAM-SHA-256-PLUS')),
      { password: 'hunter2' },
    ],
    [
      'an ErrorResponse during authentication',
      (stream) => stream.push(errorResponse({ C: '28P01', M: 'password authentication failed' })),
      {},
    ],
    [
      'an ErrorResponse between AuthenticationOk and ReadyForQuery',
      (stream) => stream.push(authOk(), errorResponse({ C: '0A000', M: 'wal_level is replica' })),
      {},
    ],
    ['an EOF before the first message', (stream) => stream.end(), {}],
    [
      'an EOF after AuthenticationOk but before ReadyForQuery',
      (stream) => {
        stream.push(authOk());
        stream.end();
      },
      {},
    ],
  ];

  test.each(scripts)('%s closes the stream', async (_label, script, extra) => {
    const stream = new FakeStream();
    script(stream);
    const error = await PgConnection.open(opts(stream, extra)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(stream.closed).toBe(true);
  });

  test('a startup write that throws closes the stream and rethrows that failure', async () => {
    const stream = new FakeStream();
    const boom = new Error('socket refused the startup packet');
    stream.throwOnNextWrite(boom);
    const error = await PgConnection.open(opts(stream)).catch((caught: unknown) => caught);
    expect(error).toBe(boom);
    expect(stream.closed).toBe(true);
  });

  test('a close() that itself throws does not mask the handshake failure', async () => {
    const stream = new FakeStream();
    stream.throwOnClose(new Error('close failed too'));
    stream.push(authGssapi());
    const error = await PgConnection.open(opts(stream)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationProtocolError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_PROTOCOL');
  });

  test('a handshake that succeeds leaves the stream open — the close is on failure only', async () => {
    const stream = new FakeStream();
    await openTrusted(stream);
    expect(stream.closed).toBe(false);
  });
});

describe('query', () => {
  test('DataRow becomes string | null (-1 length is null, not ""); no DataRow returns []', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    stream.push(
      rowDescriptionStub(),
      dataRow('1', null),
      dataRow('', 'x'),
      commandComplete('SELECT 2'),
      readyForQuery(),
    );
    expect(await connection.query('select a, b from t')).toEqual([
      ['1', null],
      ['', 'x'],
    ]);
    stream.push(commandComplete('DELETE 0'), readyForQuery());
    expect(await connection.query('delete from t')).toEqual([]);
  });

  test('an ErrorResponse drains to ReadyForQuery and leaves the connection usable', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    stream.push(errorResponse({ C: '42601', M: 'syntax error' }), readyForQuery());
    const error = await connection.query('not sql').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    stream.push(commandComplete('SELECT 0'), readyForQuery());
    expect(await connection.query('select 1')).toEqual([]);
  });

  test('a ParameterStatus mid-query updates parameter() rather than becoming a row', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    stream.push(
      parameterStatus('application_name', 'walsender'),
      commandComplete('SET'),
      readyForQuery(),
    );
    const rows = await connection.query("set application_name = 'walsender'");
    expect(rows).toEqual([]);
    expect(connection.parameter('application_name')).toBe('walsender');
  });

  test('a NoticeResponse anywhere is ignored — no throw, no row', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    stream.push(
      noticeResponse({ S: 'NOTICE', C: '00000', M: 'vacuuming' }),
      dataRow('1'),
      commandComplete('SELECT 1'),
      readyForQuery(),
    );
    expect(await connection.query('select 1')).toEqual([['1']]);
  });
});

describe('startCopyBoth', () => {
  test('resolves on CopyBothResponse and flips inCopyBoth; an E rejects with X_REPLICATION_FAILED', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    stream.push(copyBothResponse());
    expect(connection.inCopyBoth).toBe(false);
    await connection.startCopyBoth(START_REPLICATION_SQL);
    expect(connection.inCopyBoth).toBe(true);
    const sent = decodeFrame(writeAt(stream, 1));
    expect(sent.tag).toBe('Q');
    expect(new ByteReader(sent.body).cstring()).toBe(START_REPLICATION_SQL);

    const failing = new FakeStream();
    const failingConnection = await openTrusted(failing);
    failing.push(errorResponse({ C: '42704', M: 'replication slot "s" does not exist' }));
    const error = await failingConnection
      .startCopyBoth(START_REPLICATION_SQL)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
  });
});

describe('nextCopyData', () => {
  test('returns each payload in order, then undefined with inCopyBoth reset on CopyDone', async () => {
    const stream = new FakeStream();
    const connection = await openInCopyBoth(stream);
    stream.push(
      copyData(new Uint8Array([1, 2, 3])),
      copyData(new Uint8Array([4, 5])),
      copyDoneFrame(),
    );
    const first = await connection.nextCopyData();
    const second = await connection.nextCopyData();
    expect(first && [...first]).toEqual([1, 2, 3]);
    expect(second && [...second]).toEqual([4, 5]);
    expect(await connection.nextCopyData()).toBeUndefined();
    expect(connection.inCopyBoth).toBe(false);
  });

  test('a clean EOF returns undefined; an ErrorResponse rejects with X_REPLICATION_FAILED', async () => {
    const eofStream = new FakeStream();
    const eofConnection = await openInCopyBoth(eofStream);
    eofStream.end();
    expect(await eofConnection.nextCopyData()).toBeUndefined();

    const failing = new FakeStream();
    const failingConnection = await openInCopyBoth(failing);
    failing.push(errorResponse({ C: '57P01', M: 'terminating connection' }));
    const error = await failingConnection.nextCopyData().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
  });
});

describe('sendCopyData', () => {
  test('writes a d-framed message with the exact payload', async () => {
    const stream = new FakeStream();
    const connection = await openInCopyBoth(stream);
    const payload = new Uint8Array([0x72, 0, 0, 0, 0, 1, 2, 3]);
    await connection.sendCopyData(payload);
    const sent = decodeFrame(writeAt(stream, 2)); // 0: startup, 1: the Query for START_REPLICATION
    expect(sent.tag).toBe('d');
    expect([...sent.body]).toEqual([...payload]);
  });
});

describe('close', () => {
  test('writes Terminate and closes the stream; a second close writes nothing', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    await connection.close();
    const sent = decodeFrame(writeAt(stream, 1));
    expect(sent.tag).toBe('X');
    expect(sent.body.length).toBe(0);
    expect(stream.closed).toBe(true);

    const writeCountAfterFirstClose = stream.writes.length;
    await connection.close();
    expect(stream.writes.length).toBe(writeCountAfterFirstClose);
  });

  test('a write that throws during close still closes the stream', async () => {
    const stream = new FakeStream();
    const connection = await openTrusted(stream);
    stream.throwOnNextWrite(new Error('socket already gone'));
    await connection.close();
    expect(stream.closed).toBe(true);
  });
});
