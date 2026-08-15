// Tests for the bus port's own half: the URL a boot is configured with. The library takes a bare
// `host:port` and its credentials as separate options and never reads a URL's userinfo, so every
// credential in `NATS_URL` is found here or nowhere — which is why this file outlived the wire
// client it used to sit next to.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { TransportUnavailableError } from './errors';
import { DEFAULT_NATS_PORT, parseNatsUrl } from './nats-client';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

const codeOf = (value: unknown): string =>
  isUltimateError(value) ? value.code : `not an UltimateError: ${String(value)}`;

const causeOf = (value: unknown): string =>
  isUltimateError(value) ? value.cause : `not an UltimateError: ${String(value)}`;

describe('parseNatsUrl', () => {
  test('parses a full URL: user, password, port, tls', () => {
    const target = parseNatsUrl('nats://alice:s3cret@bus.example.test:4333');
    expect(target).toEqual({
      host: 'bus.example.test',
      port: 4333,
      tls: false,
      user: 'alice',
      pass: 's3cret',
      token: undefined,
    });
  });

  test('defaults: no port -> 4222, no credentials -> undefined', () => {
    const target = parseNatsUrl('nats://bus.example.test');
    expect(target).toEqual({
      host: 'bus.example.test',
      port: DEFAULT_NATS_PORT,
      tls: false,
      user: undefined,
      pass: undefined,
      token: undefined,
    });
  });

  test('a username with no password is the token form', () => {
    const target = parseNatsUrl('nats://sometoken@bus.example.test');
    expect(target.token).toBe('sometoken');
    expect(target.user).toBeUndefined();
    expect(target.pass).toBeUndefined();
  });

  test('percent-encoded user and password are decoded', () => {
    const target = parseNatsUrl('nats://ali%40ce:p%40ss@bus.example.test');
    expect(target.user).toBe('ali@ce');
    expect(target.pass).toBe('p@ss');
  });

  test('tls: scheme sets tls: true', () => {
    expect(parseNatsUrl('tls://bus.example.test').tls).toBe(true);
    expect(parseNatsUrl('nats://bus.example.test').tls).toBe(false);
  });

  test('a non-nats scheme or a non-URL string is X_TRANSPORT_UNAVAILABLE', () => {
    for (const bad of ['http://user:pass@host/db', 'not a url at all']) {
      const error = thrown(() => parseNatsUrl(bad));
      expect(error).toBeInstanceOf(TransportUnavailableError);
      expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    }
  });

  test('an empty host is X_TRANSPORT_UNAVAILABLE', () => {
    const error = thrown(() => parseNatsUrl('nats://'));
    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
  });

  test('a password with no user is refused rather than connecting anonymously', () => {
    const error = thrown(() => parseNatsUrl('nats://:s3cret@bus.example.test'));

    expect(error).toBeInstanceOf(TransportUnavailableError);
    expect(codeOf(error)).toBe('X_TRANSPORT_UNAVAILABLE');
    // Both legal forms are named, and the secret itself never reaches a log line.
    expect(isUltimateError(error) ? error.fix : '').toContain('nats://<user>:<pass>@');
    expect(isUltimateError(error) ? error.fix : '').toContain('nats://<token>@');
    expect(causeOf(error)).not.toContain('s3cret');
  });
});
