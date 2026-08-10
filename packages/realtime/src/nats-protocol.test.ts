// Tests for the decode half of the protocol: `NatsProtocolParser` reassembly over hand-fed chunks
// (no sockets, no timers) and the header-block parser. Every frame is built by hand rather than by
// the encoders, so a matched pair of bugs on both sides could not cancel out.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { TransportProtocolError } from './errors';
import {
  type NatsMessage,
  type NatsOperation,
  NatsProtocolParser,
  parseHeaders,
} from './nats-protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

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

/** Narrows a `NatsOperation` to its `msg` variant, failing the test with a clear diff if not. */
const expectMessage = (op: NatsOperation | undefined): NatsMessage => {
  expect(op?.kind).toBe('msg');
  return (op as Extract<NatsOperation, { kind: 'msg' }>).message;
};

/** Hand-built server MSG frame — independent of `pubMessage`, which builds the client side. */
const rawMsg = (subject: string, sid: string, payload: string, replyTo?: string): Uint8Array => {
  const bytes = encoder.encode(payload);
  const replyPart = replyTo !== undefined ? ` ${replyTo}` : '';
  const control = `MSG ${subject} ${sid}${replyPart} ${bytes.length}\r\n`;
  return concat(encoder.encode(control), bytes, encoder.encode('\r\n'));
};

/** Hand-built server HMSG frame, given an already-assembled header block string. */
const rawHmsg = (
  subject: string,
  sid: string,
  headerBlock: string,
  payload: string,
  replyTo?: string,
): Uint8Array => {
  const headerBytes = encoder.encode(headerBlock);
  const payloadBytes = encoder.encode(payload);
  const total = headerBytes.length + payloadBytes.length;
  const replyPart = replyTo !== undefined ? ` ${replyTo}` : '';
  const control = `HMSG ${subject} ${sid}${replyPart} ${headerBytes.length} ${total}\r\n`;
  return concat(encoder.encode(control), headerBytes, payloadBytes, encoder.encode('\r\n'));
};

describe('NatsProtocolParser — INFO', () => {
  test('a full INFO line parses every field', () => {
    const parser = new NatsProtocolParser();
    const json = JSON.stringify({
      server_id: 'NABC123',
      version: '2.10.7',
      max_payload: 1048576,
      tls_required: true,
      tls_available: true,
      auth_required: true,
      headers: true,
      nonce: 'abc123',
    });
    parser.push(encoder.encode(`INFO ${json}\r\n`));

    expect(parser.next()).toEqual({
      kind: 'info',
      info: {
        serverId: 'NABC123',
        version: '2.10.7',
        maxPayload: 1048576,
        tlsRequired: true,
        tlsAvailable: true,
        authRequired: true,
        headers: true,
        nonce: 'abc123',
      },
    });
  });

  test('a minimal INFO ({}) falls back to defaults', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('INFO {}\r\n'));

    expect(parser.next()).toEqual({
      kind: 'info',
      info: {
        serverId: '',
        version: '',
        maxPayload: 1_048_576,
        tlsRequired: false,
        tlsAvailable: false,
        authRequired: false,
        headers: false,
        nonce: undefined,
      },
    });
  });

  test('INFO json that is not an object is rejected as X_TRANSPORT_PROTOCOL', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('INFO [1,2,3]\r\n'));

    const error = caught(() => parser.next());

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
  });

  test('INFO json that does not parse at all is rejected as X_TRANSPORT_PROTOCOL', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('INFO {not json}\r\n'));

    const error = caught(() => parser.next());

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
  });
});

describe('NatsProtocolParser — MSG', () => {
  test('MSG without a reply-to', () => {
    const parser = new NatsProtocolParser();
    parser.push(rawMsg('orders.created', '9', 'hello'));

    const message = expectMessage(parser.next());

    expect(message.subject).toBe('orders.created');
    expect(message.sid).toBe('9');
    expect(message.replyTo).toBeUndefined();
    expect(decoder.decode(message.payload)).toBe('hello');
    expect(message.headers.size).toBe(0);
    expect(message.status).toBeUndefined();
    expect(message.description).toBeUndefined();
  });

  test('MSG with a reply-to', () => {
    const parser = new NatsProtocolParser();
    parser.push(rawMsg('orders.created', '9', 'hello', '_INBOX.abc'));

    const message = expectMessage(parser.next());

    expect(message.replyTo).toBe('_INBOX.abc');
    expect(decoder.decode(message.payload)).toBe('hello');
  });

  test('an empty payload is a legal zero-byte MSG', () => {
    const parser = new NatsProtocolParser();
    parser.push(rawMsg('orders.created', '1', ''));

    const message = expectMessage(parser.next());

    expect(message.payload.length).toBe(0);
  });
});

describe('NatsProtocolParser — HMSG', () => {
  test('HMSG with headers', () => {
    const parser = new NatsProtocolParser();
    const headerBlock = 'NATS/1.0\r\nKey: Value\r\nOther: Thing\r\n\r\n';
    parser.push(rawHmsg('orders.created', '3', headerBlock, 'payload-body'));

    const message = expectMessage(parser.next());

    expect(message.headers.get('key')).toBe('Value');
    expect(message.headers.get('other')).toBe('Thing');
    expect(decoder.decode(message.payload)).toBe('payload-body');
    expect(message.status).toBeUndefined();
    expect(message.description).toBeUndefined();
  });

  test('HMSG with a status line (404 No Messages) and no payload', () => {
    const parser = new NatsProtocolParser();
    const headerBlock = 'NATS/1.0 404 No Messages\r\n\r\n';
    parser.push(rawHmsg('orders.created', '3', headerBlock, ''));

    const message = expectMessage(parser.next());

    expect(message.status).toBe(404);
    expect(message.description).toBe('No Messages');
    expect(message.headers.size).toBe(0);
    expect(message.payload.length).toBe(0);
  });

  test('HMSG with an idle-heartbeat status', () => {
    const parser = new NatsProtocolParser();
    const headerBlock = 'NATS/1.0 100 Idle Heartbeat\r\n\r\n';
    parser.push(rawHmsg('orders.created', '3', headerBlock, ''));

    const message = expectMessage(parser.next());

    expect(message.status).toBe(100);
    expect(message.description).toBe('Idle Heartbeat');
  });

  test('HMSG with an empty header set (no keys) is legal', () => {
    const parser = new NatsProtocolParser();
    const headerBlock = 'NATS/1.0\r\n\r\n';
    parser.push(rawHmsg('orders.created', '3', headerBlock, 'x'));

    const message = expectMessage(parser.next());

    expect(message.headers.size).toBe(0);
    expect(message.status).toBeUndefined();
    expect(decoder.decode(message.payload)).toBe('x');
  });

  test('HMSG with a reply-to carries both the reply subject and the headers', () => {
    const parser = new NatsProtocolParser();
    const headerBlock = 'NATS/1.0\r\nKey: Value\r\n\r\n';
    parser.push(rawHmsg('orders.created', '3', headerBlock, 'x', '_INBOX.def'));

    const message = expectMessage(parser.next());

    expect(message.replyTo).toBe('_INBOX.def');
    expect(message.headers.get('key')).toBe('Value');
  });
});

describe('NatsProtocolParser — chunk boundaries', () => {
  test('a payload split across three chunks, split mid control line and mid payload, reassembles whole', () => {
    const full = rawMsg('orders.created', '1', 'hello world');
    const parser = new NatsProtocolParser();

    parser.push(full.slice(0, 5));
    expect(parser.next()).toBeUndefined();
    parser.push(full.slice(5, full.length - 4));
    expect(parser.next()).toBeUndefined();
    parser.push(full.slice(full.length - 4));

    const message = expectMessage(parser.next());
    expect(decoder.decode(message.payload)).toBe('hello world');
  });

  test('a chunk boundary between the payload and its trailing CRLF is held back', () => {
    const full = rawMsg('a', '1', 'xyz');
    const parser = new NatsProtocolParser();
    parser.push(full.slice(0, full.length - 2));

    expect(parser.next()).toBeUndefined();

    parser.push(full.slice(full.length - 2));
    const message = expectMessage(parser.next());
    expect(decoder.decode(message.payload)).toBe('xyz');
  });

  test('two operations delivered in one chunk are returned one at a time', () => {
    const chunk = concat(encoder.encode('PING\r\n'), rawMsg('a', '1', 'x'));
    const parser = new NatsProtocolParser();
    parser.push(chunk);

    expect(parser.next()).toEqual({ kind: 'ping' });
    const message = expectMessage(parser.next());
    expect(message.subject).toBe('a');
    expect(parser.next()).toBeUndefined();
  });

  test('a control line split mid-verb waits for the rest; buffered tracks it meanwhile', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('PI'));

    expect(parser.next()).toBeUndefined();
    expect(parser.buffered).toBe(2);

    parser.push(encoder.encode('NG\r\n'));
    expect(parser.next()).toEqual({ kind: 'ping' });
    expect(parser.buffered).toBe(0);
  });
});

describe('NatsProtocolParser — control operations', () => {
  test('PING, PONG and +OK parse from one buffered chunk', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('PING\r\nPONG\r\n+OK\r\n'));

    expect(parser.next()).toEqual({ kind: 'ping' });
    expect(parser.next()).toEqual({ kind: 'pong' });
    expect(parser.next()).toEqual({ kind: 'ok' });
    expect(parser.next()).toBeUndefined();
  });

  test('-ERR strips the surrounding quotes and trims', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode("-ERR 'Authorization Violation'\r\n"));

    expect(parser.next()).toEqual({ kind: 'err', detail: 'Authorization Violation' });
  });

  test('verbs are matched case-insensitively', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('ping\r\n'));

    expect(parser.next()).toEqual({ kind: 'ping' });
  });
});

describe('NatsProtocolParser — protocol violations', () => {
  test('a declared payload above 64 MiB is refused without waiting for the bytes', () => {
    const parser = new NatsProtocolParser();
    const oversized = 64 * 1024 * 1024 + 1;
    parser.push(encoder.encode(`MSG a 1 ${oversized}\r\n`));

    const error = caught(() => parser.next());

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
  });

  test('an unknown verb is rejected', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('BOGUS foo\r\n'));

    const error = caught(() => parser.next());

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
  });

  test('MSG with a wrong argument count is rejected', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('MSG only-one-arg\r\n'));

    const error = caught(() => parser.next());

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
  });

  test('a non-numeric byte count is rejected', () => {
    const parser = new NatsProtocolParser();
    parser.push(encoder.encode('MSG a 1 not-a-number\r\n'));

    const error = caught(() => parser.next());

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
  });
});

describe('parseHeaders', () => {
  test('an empty header block (no keys) parses to an empty map with no status', () => {
    const result = parseHeaders(encoder.encode('NATS/1.0\r\n\r\n'));

    expect(result.headers.size).toBe(0);
    expect(result.status).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  test('keys are lower-cased and values are trimmed; duplicate keys keep the last value', () => {
    const result = parseHeaders(
      encoder.encode('NATS/1.0\r\nKey:   value  \r\nKEY: second\r\n\r\n'),
    );

    expect(result.headers.size).toBe(1);
    expect(result.headers.get('key')).toBe('second');
  });

  test('a header value containing a colon splits on the first colon only', () => {
    const result = parseHeaders(encoder.encode('NATS/1.0\r\nTime: 10:30:00\r\n\r\n'));

    expect(result.headers.get('time')).toBe('10:30:00');
  });

  test('a header block not starting with NATS/1.0 is rejected as X_TRANSPORT_PROTOCOL', () => {
    const error = caught(() => parseHeaders(encoder.encode('BOGUS\r\n\r\n')));

    expect(error).toBeInstanceOf(TransportProtocolError);
    expect(codeOf(error)).toBe('X_TRANSPORT_PROTOCOL');
  });
});
