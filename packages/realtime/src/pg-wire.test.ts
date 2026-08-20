// Tests for the frame layer: `MessageReader` reassembly over an injected `PgStream`, the
// frontend builders asserted byte-for-byte, and the ErrorResponse parsing that feeds
// `serverError`. No network and no real Postgres — every fixture is hand-built or fed back
// through `MessageReader` via a stub stream that yields queued chunks then a clean EOF.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { DEFAULT_REPLICATION_PUBLICATION } from './changefeed-env';
import { ReplicationFailedError, ReplicationProtocolError } from './errors';
import { ByteWriter } from './pg-bytes';
import {
  copyDoneMessage,
  describeFields,
  FIXES,
  frame,
  MessageReader,
  type PgStream,
  passwordMessage,
  queryMessage,
  responseFields,
  saslInitialResponse,
  saslResponse,
  serverError,
  sslRequest,
  startupMessage,
  terminateMessage,
} from './pg-wire';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};

/** tag + Int32 length (body + 4) + body, hand-built so these fixtures do not depend on `frame`. */
const rawMessage = (tag: string, body: Uint8Array): Uint8Array =>
  new ByteWriter(body.length + 5)
    .uint8(tag.charCodeAt(0))
    .int32(body.length + 4)
    .raw(body)
    .finish();

/** Hands out fixed chunks in order; an exhausted queue reads as a clean EOF (`undefined`). */
class QueueStream implements PgStream {
  readonly #chunks: Uint8Array[];
  reads = 0;

  constructor(chunks: readonly Uint8Array[]) {
    this.#chunks = [...chunks];
  }

  read(): Promise<Uint8Array | undefined> {
    this.reads += 1;
    return Promise.resolve(this.#chunks.shift());
  }

  write(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}
}

describe('MessageReader', () => {
  test('two complete messages in one chunk are returned one at a time', async () => {
    const chunk = concat(
      rawMessage('Q', encoder.encode('one')),
      rawMessage('Q', encoder.encode('two')),
    );
    const reader = new MessageReader(new QueueStream([chunk]));

    const first = await reader.next();
    const second = await reader.next();

    expect(first?.tag).toBe('Q');
    expect(decoder.decode(first?.body)).toBe('one');
    expect(second?.tag).toBe('Q');
    expect(decoder.decode(second?.body)).toBe('two');
  });

  test('a message split across three chunks, split inside the length prefix, reassembles whole', async () => {
    const full = rawMessage('D', encoder.encode('hello world'));
    // Boundaries after byte 1 and byte 3 both land inside the 4-byte length prefix (bytes 1-4),
    // so `#take` must see fewer than 5 buffered bytes twice before it can even read the length.
    const stream = new QueueStream([full.slice(0, 2), full.slice(2, 4), full.slice(4)]);
    const reader = new MessageReader(stream);

    const message = await reader.next();

    expect(message?.tag).toBe('D');
    expect(decoder.decode(message?.body)).toBe('hello world');
  });

  test('a second message only partially delivered waits for the rest; buffered tracks it meanwhile', async () => {
    const m1 = rawMessage('D', encoder.encode('first'));
    const m2 = rawMessage('D', encoder.encode('second-message-body'));
    const stream = new QueueStream([concat(m1, m2.slice(0, 6)), m2.slice(6)]);
    const reader = new MessageReader(stream);

    const first = await reader.next();
    expect(decoder.decode(first?.body)).toBe('first');
    expect(stream.reads).toBe(1);
    expect(reader.buffered).toBe(6);

    const second = await reader.next();
    expect(decoder.decode(second?.body)).toBe('second-message-body');
    expect(stream.reads).toBe(2);
    expect(reader.buffered).toBe(0);
  });

  test('a clean EOF on an empty buffer returns undefined', async () => {
    const reader = new MessageReader(new QueueStream([]));
    expect(await reader.next()).toBeUndefined();
  });

  test('an EOF with a partial message in the buffer throws X_REPLICATION_PROTOCOL', async () => {
    const partial = rawMessage('D', encoder.encode('hello')).slice(0, 4);
    const reader = new MessageReader(new QueueStream([partial]));

    const error = await caught(reader.next());

    expect(error).toBeInstanceOf(ReplicationProtocolError);
    expect(codeOf(error)).toBe('X_REPLICATION_PROTOCOL');
  });

  test('a declared length below 4 is refused as a corrupt frame', async () => {
    const bytes = new ByteWriter(5).uint8('X'.charCodeAt(0)).int32(3).finish();
    const reader = new MessageReader(new QueueStream([bytes]));

    const error = await caught(reader.next());

    expect(error).toBeInstanceOf(ReplicationProtocolError);
    expect(codeOf(error)).toBe('X_REPLICATION_PROTOCOL');
  });

  test('a declared length above 64MB is refused — the "you pointed me at an HTTP port" case', async () => {
    const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
    const bytes = new ByteWriter(5)
      .uint8('H'.charCodeAt(0))
      .int32(MAX_MESSAGE_BYTES + 1)
      .finish();
    const reader = new MessageReader(new QueueStream([bytes]));

    const error = await caught(reader.next());

    expect(error).toBeInstanceOf(ReplicationProtocolError);
    expect(codeOf(error)).toBe('X_REPLICATION_PROTOCOL');
  });

  test('a zero-length body (length === 4) is returned with an empty body', async () => {
    const reader = new MessageReader(new QueueStream([copyDoneMessage()]));

    const message = await reader.next();

    expect(message?.tag).toBe('c');
    expect(message?.body.length).toBe(0);
  });
});

describe('builders', () => {
  test('frame is tag, then Int32 length (body + 4), then the body', () => {
    const bytes = frame('Q', new Uint8Array([1, 2, 3]));
    expect([...bytes]).toEqual(['Q'.charCodeAt(0), 0, 0, 0, 7, 1, 2, 3]);
  });

  test('startupMessage has no tag: its own length, then PROTOCOL_3_0, then key/value cstrings', () => {
    const bytes = startupMessage({ user: 'x', database: 'y' });

    // Int32 total length (27, counting itself), then Int32 protocol version 196_608.
    expect([...bytes.subarray(0, 8)]).toEqual([0, 0, 0, 27, 0, 3, 0, 0]);
    expect([...bytes.subarray(8)]).toEqual([...encoder.encode('user\0x\0database\0y\0'), 0]);
    expect(bytes.length).toBe(27);
  });

  test('sslRequest is exactly 8 bytes: Int32 8, Int32 80877103', () => {
    expect([...sslRequest()]).toEqual([0, 0, 0, 8, 4, 210, 22, 47]);
  });

  test('saslInitialResponse frames as p + mechanism cstring + Int32 length + payload', () => {
    const initial = new Uint8Array([1, 2, 3, 4]);
    const bytes = saslInitialResponse('SCRAM-SHA-256', initial);

    expect([...bytes]).toEqual([
      'p'.charCodeAt(0),
      0,
      0,
      0,
      26, // 14 (mechanism cstring) + 4 (Int32 length) + 4 (payload) + 4 (frame counts itself)
      ...encoder.encode('SCRAM-SHA-256\0'),
      0,
      0,
      0,
      4,
      1,
      2,
      3,
      4,
    ]);
  });

  test('saslResponse is a bare p frame around the payload', () => {
    const bytes = saslResponse(new Uint8Array([9, 8, 7]));
    expect([...bytes]).toEqual(['p'.charCodeAt(0), 0, 0, 0, 7, 9, 8, 7]);
  });

  test('passwordMessage NUL-terminates the password', () => {
    const bytes = passwordMessage('s3cret');
    expect([...bytes]).toEqual(['p'.charCodeAt(0), 0, 0, 0, 11, ...encoder.encode('s3cret\0')]);
  });

  test('queryMessage NUL-terminates the query string', () => {
    const bytes = queryMessage('SELECT 1');
    expect([...bytes]).toEqual(['Q'.charCodeAt(0), 0, 0, 0, 13, ...encoder.encode('SELECT 1\0')]);
  });

  test('terminateMessage and copyDoneMessage have empty bodies', () => {
    expect([...terminateMessage()]).toEqual(['X'.charCodeAt(0), 0, 0, 0, 4]);
    expect([...copyDoneMessage()]).toEqual(['c'.charCodeAt(0), 0, 0, 0, 4]);
  });

  test('every tagged builder round-trips through MessageReader with the length arithmetic intact', async () => {
    const fixtures: readonly (readonly [string, Uint8Array])[] = [
      ['Q', frame('Q', new Uint8Array([1, 2]))],
      ['p', passwordMessage('hunter2')],
      ['p', saslInitialResponse('SCRAM-SHA-256', new Uint8Array([1]))],
      ['p', saslResponse(new Uint8Array([1, 2, 3]))],
      ['Q', queryMessage('SELECT 1')],
      ['X', terminateMessage()],
      ['c', copyDoneMessage()],
    ];

    for (const [tag, bytes] of fixtures) {
      const reader = new MessageReader(new QueueStream([bytes]));
      const message = await reader.next();
      expect(message?.tag).toBe(tag);
      expect(reader.buffered).toBe(0);
    }
  });

  test('startupMessage and sslRequest are untagged by design and are not readable as a message', async () => {
    for (const bytes of [startupMessage({ user: 'x', database: 'y' }), sslRequest()]) {
      const reader = new MessageReader(new QueueStream([bytes]));
      const error = await caught(reader.next());
      expect(error).toBeInstanceOf(ReplicationProtocolError);
      expect(codeOf(error)).toBe('X_REPLICATION_PROTOCOL');
    }
  });
});

describe('responseFields / describeFields / serverError', () => {
  const errorBody = (fields: readonly (readonly [string, string])[]): Uint8Array => {
    const writer = new ByteWriter(64);
    for (const [code, value] of fields) writer.uint8(code.charCodeAt(0)).cstring(value);
    return writer.uint8(0).finish();
  };

  test('S/C/M fields terminated by a zero byte parse into a record', () => {
    const body = errorBody([
      ['S', 'FATAL'],
      ['C', '28P01'],
      ['M', 'password authentication failed'],
    ]);

    expect(responseFields(body)).toEqual({
      S: 'FATAL',
      C: '28P01',
      M: 'password authentication failed',
    });
  });

  test('describeFields joins SQLSTATE, message, detail and hint', () => {
    const fields = {
      C: '0A000',
      M: 'cannot proceed',
      D: 'wal_level is replica',
      H: 'set it to logical',
    };
    expect(describeFields(fields)).toBe(
      '0A000 — cannot proceed — wal_level is replica — set it to logical',
    );
  });

  test('describeFields does not crash on a body with only M, or with none at all', () => {
    expect(describeFields({ M: 'only a message' })).toBe('only a message');
    expect(describeFields({})).toBe('the server reported no message');
  });

  test('serverError returns a ReplicationFailedError with the SQLSTATE-specific fix', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['28P01', 'correct the password in the replication URL — the server refused the credentials'],
      [
        '55006',
        'another replicator holds the slot — exactly one replicator per database, by design',
      ],
      ['0A000', 'set wal_level = logical in postgresql.conf and restart the server'],
    ];

    for (const [sqlstate, fix] of cases) {
      const error = serverError(
        'auth',
        errorBody([
          ['C', sqlstate],
          ['M', 'boom'],
        ]),
      );
      expect(error).toBeInstanceOf(ReplicationFailedError);
      expect(error.code).toBe('X_REPLICATION_FAILED');
      expect(error.fix).toBe(fix);
    }
  });

  /**
   * `42704` said `x db replication init` until 2026-08-20 and `x db` has no such subcommand — a
   * `fix:` that is a no-op, which is the failure axiom 4 exists to prevent. It shipped because the
   * fix was read out of a TABLE (`fix: FIXES[code]`), and the `errors` step only ever read `fix:`
   * literals; the table is scanned as of #97, so a seventh entry is checked the day it is written.
   *
   * What that gate still cannot check is whether the publication NAME is the one the feed looks
   * for, because it is a copy: `pg-wire.ts` may not import `changefeed-env.ts` without closing a
   * cycle, and a test may.
   */
  test('the 42704 fix names the publication the change feed actually defaults to', () => {
    const fix = FIXES['42704'] ?? '';
    expect(fix).toInclude(DEFAULT_REPLICATION_PUBLICATION);
    expect(fix).toInclude('CREATE PUBLICATION');
    expect(fix).not.toInclude('x db replication');
  });

  test('serverError falls back to the generic x doctor db fix for an unknown SQLSTATE', () => {
    const error = serverError(
      'auth',
      errorBody([
        ['C', 'XXNOPE'],
        ['M', 'boom'],
      ]),
    );
    expect(error.fix).toBe('x doctor db — the postgres message above names the object to change');
  });
});
