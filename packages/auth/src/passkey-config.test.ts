// `defineAuth({ passkeys })` refuses, where it is written, every relying party the ceremonies
// could not verify against — and resolves a good one with its defaults.

import { describe, expect, test } from 'bun:test';
import { defineAuth } from './auth';
import { caught } from './auth-fixture';
import { memoryAuthAdapter } from './memory-adapter';
import { DEFAULT_PASSKEY_CHALLENGE_TTL_MS, type PasskeyPolicyInput } from './passkey-config';

const define = (passkeys: PasskeyPolicyInput) =>
  defineAuth({ adapter: memoryAuthAdapter(), passkeys });

describe('defineAuth({ passkeys })', () => {
  test('a good block resolves with its defaults', () => {
    const auth = define({
      rpId: 'example.com',
      origins: ['https://example.com', 'https://app.example.com'],
    });
    expect(auth.passkeys).toEqual({
      rpId: 'example.com',
      origins: ['https://example.com', 'https://app.example.com'],
      rpName: 'example.com',
      challengeTtlMs: DEFAULT_PASSKEY_CHALLENGE_TTL_MS,
    });
  });

  test('http://localhost is the one insecure origin allowed', () => {
    expect(define({ rpId: 'localhost', origins: ['http://localhost:3000'] }).passkeys?.rpId).toBe(
      'localhost',
    );
  });

  test('no block means no passkeys', () => {
    expect(defineAuth({ adapter: memoryAuthAdapter() }).passkeys).toBeUndefined();
  });

  test.each([
    ['a URL as the rp id', { rpId: 'https://example.com', origins: ['https://example.com'] }],
    ['an upper-case rp id', { rpId: 'Example.com', origins: ['https://example.com'] }],
    ['an IP rp id', { rpId: '10.0.0.1', origins: ['https://10.0.0.1'] }],
    ['no origins', { rpId: 'example.com', origins: [] }],
    ['an origin on another host', { rpId: 'example.com', origins: ['https://example.net'] }],
    [
      'a suffix that is not a subdomain',
      { rpId: 'example.com', origins: ['https://badexample.com'] },
    ],
    ['plain http off localhost', { rpId: 'example.com', origins: ['http://example.com'] }],
    ['an origin with a path', { rpId: 'example.com', origins: ['https://example.com/login'] }],
    ['an origin with a trailing slash', { rpId: 'example.com', origins: ['https://example.com/'] }],
    [
      'a NaN ttl',
      { rpId: 'example.com', origins: ['https://example.com'], challengeTtlMs: Number.NaN },
    ],
    ['a zero ttl', { rpId: 'example.com', origins: ['https://example.com'], challengeTtlMs: 0 }],
  ])('%s is X_CONFIG_INVALID', async (_name, passkeys) => {
    expect((await caught(async () => define(passkeys)))?.code).toBe('X_CONFIG_INVALID');
  });
});
