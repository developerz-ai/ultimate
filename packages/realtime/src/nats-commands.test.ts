// Tests for the client half of the protocol: every command a client writes, asserted byte for
// byte. Building the bytes by hand here rather than round-tripping through the parser is the
// point — a matched pair of bugs in an encoder and its own decoder would cancel out.

import { describe, expect, test } from 'bun:test';
import {
  connectMessage,
  PING_MESSAGE,
  PONG_MESSAGE,
  pubMessage,
  subMessage,
  unsubMessage,
} from './nats-commands';
import type { NatsHeaders } from './nats-protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('connectMessage', () => {
  const parseConnect = (bytes: Uint8Array): Record<string, unknown> => {
    const text = decoder.decode(bytes);
    expect(text.startsWith('CONNECT ')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    return JSON.parse(text.slice('CONNECT '.length, text.length - 2)) as Record<string, unknown>;
  };

  test('defaults: no creds, tls_required/verbose/pedantic false, the fixed identity fields', () => {
    const json = parseConnect(connectMessage());

    expect(json).toMatchObject({
      verbose: false,
      pedantic: false,
      tls_required: false,
      name: 'ultimate',
      lang: 'bun',
      version: '0.0.1',
      protocol: 1,
      headers: true,
      no_responders: true,
    });
    expect('user' in json).toBe(false);
    expect('pass' in json).toBe(false);
    expect('auth_token' in json).toBe(false);
  });

  test('user/pass are included only when both are given', () => {
    const withBoth = parseConnect(connectMessage({ user: 'alice', pass: 'secret' }));
    expect(withBoth['user']).toBe('alice');
    expect(withBoth['pass']).toBe('secret');

    const userOnly = parseConnect(connectMessage({ user: 'alice', pass: undefined }));
    expect('user' in userOnly).toBe(false);
    expect('pass' in userOnly).toBe(false);
  });

  test('auth_token is included only when given', () => {
    const withToken = parseConnect(connectMessage({ authToken: 'tok123' }));
    expect(withToken['auth_token']).toBe('tok123');

    const withoutToken = parseConnect(connectMessage({ authToken: undefined }));
    expect('auth_token' in withoutToken).toBe(false);
  });

  test('custom name and tlsRequired pass through', () => {
    const json = parseConnect(connectMessage({ name: 'worker-1', tlsRequired: true }));
    expect(json['name']).toBe('worker-1');
    expect(json['tls_required']).toBe(true);
  });
});

describe('pubMessage', () => {
  test('no headers produces PUB with the byte count of the payload', () => {
    const bytes = pubMessage({ subject: 'orders.created', payload: encoder.encode('hi') });
    expect(decoder.decode(bytes)).toBe('PUB orders.created 2\r\nhi\r\n');
  });

  test('no payload produces a zero byte count and an empty payload segment', () => {
    const bytes = pubMessage({ subject: 'orders.created' });
    expect(decoder.decode(bytes)).toBe('PUB orders.created 0\r\n\r\n');
  });

  test('a reply-to is inserted before the byte count', () => {
    const bytes = pubMessage({
      subject: 'orders.created',
      replyTo: '_INBOX.abc',
      payload: encoder.encode('hi'),
    });
    expect(decoder.decode(bytes)).toBe('PUB orders.created _INBOX.abc 2\r\nhi\r\n');
  });

  test('headers switch the verb to HPUB and count header bytes and header+payload bytes', () => {
    const headers: NatsHeaders = new Map([['Nats-Msg-Id', 'abc-123']]);
    const bytes = pubMessage({
      subject: 'orders.created',
      payload: encoder.encode('hi'),
      headers,
    });

    const headerBlock = 'NATS/1.0\r\nNats-Msg-Id: abc-123\r\n\r\n';
    const headerByteLength = encoder.encode(headerBlock).length;
    const expected = `HPUB orders.created ${headerByteLength} ${headerByteLength + 2}\r\n${headerBlock}hi\r\n`;
    expect(decoder.decode(bytes)).toBe(expected);
  });

  test('an empty headers map behaves like no headers at all (PUB, not HPUB)', () => {
    const bytes = pubMessage({ subject: 'a', payload: encoder.encode('x'), headers: new Map() });
    expect(decoder.decode(bytes)).toBe('PUB a 1\r\nx\r\n');
  });
});

describe('subMessage / unsubMessage', () => {
  test('subMessage without a queue group', () => {
    expect(decoder.decode(subMessage('orders.created', '7'))).toBe('SUB orders.created 7\r\n');
  });

  test('subMessage with a queue group', () => {
    expect(decoder.decode(subMessage('orders.created', '7', 'workers'))).toBe(
      'SUB orders.created workers 7\r\n',
    );
  });

  test('unsubMessage without a max', () => {
    expect(decoder.decode(unsubMessage('7'))).toBe('UNSUB 7\r\n');
  });

  test('unsubMessage with a max', () => {
    expect(decoder.decode(unsubMessage('7', 1))).toBe('UNSUB 7 1\r\n');
  });
});

describe('PING_MESSAGE / PONG_MESSAGE', () => {
  test('are the bare control lines, ready to write to the socket', () => {
    expect(decoder.decode(PING_MESSAGE)).toBe('PING\r\n');
    expect(decoder.decode(PONG_MESSAGE)).toBe('PONG\r\n');
  });
});
