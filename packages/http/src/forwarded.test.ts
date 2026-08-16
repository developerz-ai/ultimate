// `trustProxy` documented reading `x-forwarded-for` and nothing read it, so every anonymous
// request behind an ingress keyed the limiter to the proxy — one bucket for the internet. These
// tests pin the half that makes reading it safe: the entry a TRUSTED proxy wrote, never the one
// the client typed.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { clientAddress, clientUsedHttps, forwardedValue } from './forwarded';

const config = (hops: number | undefined) =>
  defineHttpConfig({
    rateLimit: { scope: 'process' },
    ...(hops === undefined ? {} : { trustProxy: true, trustedProxyHops: hops }),
  });

const input = (
  headers: Record<string, string>,
  hops: number | undefined,
  socket = '10.42.0.7',
) => ({
  headers: new Headers(headers),
  config: config(hops),
  socketAddress: socket,
  urlProtocol: 'http:',
});

describe('forwardedValue', () => {
  test('one trusted proxy: the single entry it appended is the client', () => {
    expect(forwardedValue('203.0.113.9', 1)).toBe('203.0.113.9');
  });

  test('two trusted proxies: the client is two from the right', () => {
    expect(forwardedValue('203.0.113.9, 198.51.100.4', 2)).toBe('203.0.113.9');
  });

  // The whole point. The attacker sends `x-forwarded-for: 1.2.3.4` and the trusted chain appends
  // its own peers to the RIGHT of it, so the leftmost value is the forgery, every time.
  test('a spoofed leftmost entry is skipped, not trusted', () => {
    expect(forwardedValue('1.2.3.4, 203.0.113.9, 198.51.100.4', 2)).toBe('203.0.113.9');
  });

  test('fewer entries than declared hops is not the configured chain, so nothing is trusted', () => {
    expect(forwardedValue('1.2.3.4', 2)).toBeUndefined();
  });

  test('zero hops trusts nothing at all', () => {
    expect(forwardedValue('203.0.113.9', 0)).toBeUndefined();
  });
});

describe('clientAddress', () => {
  test('without trustProxy the socket address is the only answer', () => {
    expect(clientAddress(input({ 'x-forwarded-for': '203.0.113.9' }, undefined))).toBe('10.42.0.7');
  });

  test('with trustProxy the forwarded entry wins', () => {
    expect(clientAddress(input({ 'x-forwarded-for': '203.0.113.9' }, 1))).toBe('203.0.113.9');
  });

  test('a port is stripped, or every connection would be its own rate-limit bucket', () => {
    expect(clientAddress(input({ 'x-forwarded-for': '203.0.113.9:51234' }, 1))).toBe('203.0.113.9');
    expect(clientAddress(input({ 'x-forwarded-for': '[2001:db8::1]:443' }, 1))).toBe('2001:db8::1');
  });

  test('a bare IPv6 keeps all of its colons', () => {
    expect(clientAddress(input({ 'x-forwarded-for': '2001:db8::1' }, 1))).toBe('2001:db8::1');
  });

  test('no header at all falls back to the socket', () => {
    expect(clientAddress(input({}, 1))).toBe('10.42.0.7');
  });
});

describe('clientUsedHttps', () => {
  // The reason HSTS was never emitted on the deployment shape the chart ships: the internal hop
  // is plain http, so `url.protocol === 'https:'` is false for every TLS-terminated request.
  test('x-forwarded-proto: https makes a plain internal hop https', () => {
    expect(clientUsedHttps(input({ 'x-forwarded-proto': 'https' }, 1))).toBe(true);
  });

  test('http says http', () => {
    expect(clientUsedHttps(input({ 'x-forwarded-proto': 'http' }, 1))).toBe(false);
  });

  test('untrusted, the header is ignored and the URL decides', () => {
    expect(clientUsedHttps(input({ 'x-forwarded-proto': 'https' }, undefined))).toBe(false);
  });

  test('a spoofed leftmost proto is skipped like an address is', () => {
    expect(clientUsedHttps(input({ 'x-forwarded-proto': 'https, http' }, 1))).toBe(false);
  });
});
