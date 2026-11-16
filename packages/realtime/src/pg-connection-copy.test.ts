// PgConnection after the handshake, against the scripted server in pg-connection-fixture.ts:
// simple query, the CopyBoth switch, copy data both ways, and close.
// Split from pg-connection.test.ts, which keeps startup and authentication.

import { describe, expect, test } from 'bun:test';
import { ReplicationFailedError } from './errors';
import { ByteReader } from './pg-bytes';
import {
  commandComplete,
  copyBothResponse,
  copyData,
  copyDoneFrame,
  dataRow,
  decodeFrame,
  errorResponse,
  FakeStream,
  noticeResponse,
  openInCopyBoth,
  openTrusted,
  parameterStatus,
  readyForQuery,
  rowDescriptionStub,
  START_REPLICATION_SQL,
} from './pg-connection-fixture';

const writeAt = (stream: FakeStream, index: number): Uint8Array => {
  const bytes = stream.writes[index];
  if (bytes === undefined) expect.unreachable(`expected a client write at index ${index}`);
  return bytes;
};

// --- Tests -------------------------------------------------------------------------------------

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
