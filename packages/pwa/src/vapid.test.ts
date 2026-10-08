// RFC 8292 from the push service's side: the token is parsed and its ES256 signature VERIFIED with
// the public key the `k=` parameter names — never only matched as a string — and the pair rules
// the boot applies (dev pair locally, refused when deployed, half a pair never completed).

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { tryDecodeBase64Url } from './push-bytes';
import {
  assertVapidPair,
  generateVapidKeys,
  importVapidKeys,
  VAPID_PRIVATE_KEY_ENV,
  VAPID_PUBLIC_KEY_ENV,
  VAPID_TOKEN_TTL_SECONDS,
  vapidAuthorization,
} from './vapid';
import { DEV_VAPID_KEYS, resolveVapidKeys, usesDevVapidKeys } from './vapid-keys';

const NOW = new Date('2026-10-08T12:00:00.000Z');

const bytes = (text: string): Uint8Array<ArrayBuffer> =>
  tryDecodeBase64Url(text) ?? expect.unreachable(`not base64url: ${text}`);

const json = (segment: string): unknown => JSON.parse(new TextDecoder().decode(bytes(segment)));

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('unit · the VAPID token (RFC 8292 §2–3)', () => {
  test('header, claims and k= are the RFC shape, and the signature verifies against k', async () => {
    const pair = await generateVapidKeys();
    const header = await vapidAuthorization({
      endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV?x=1',
      subject: 'mailto:ops@example.com',
      keys: await importVapidKeys(pair),
      publicKey: pair.publicKey,
      clock: frozenClock(NOW),
    });
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    if (match === null) return expect.unreachable(`not a vapid header: ${header}`);
    const [, h = '', c = '', s = '', k = ''] = match;
    expect(json(h)).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(json(c)).toEqual({
      // The ORIGIN — a path in `aud` is refused by every push service.
      aud: 'https://push.example.net',
      exp: NOW.getTime() / 1000 + VAPID_TOKEN_TTL_SECONDS,
      sub: 'mailto:ops@example.com',
    });
    expect(k).toBe(pair.publicKey);
    // JWS ES256 is raw r||s, 64 bytes — DER would be ~70 and fail every verifier.
    expect(bytes(s).byteLength).toBe(64);
    const verifier = await crypto.subtle.importKey(
      'raw',
      bytes(k),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifier,
      bytes(s),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  test('exp stays inside the 24 hours the RFC allows', () => {
    expect(VAPID_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
  });
});

describe('unit · the key pair', () => {
  test('a generated pair is the printable format: 87-char point starting B, 43-char scalar', async () => {
    const pair = await generateVapidKeys();
    expect(pair.publicKey).toMatch(/^B[\w-]{86}$/);
    expect(pair.privateKey).toMatch(/^[\w-]{43}$/);
    await assertVapidPair(pair);
  });

  test('two halves of different pairs are refused — WebCrypto alone would import them', async () => {
    const a = await generateVapidKeys();
    const b = await generateVapidKeys();
    expect(
      await codeOf(() => assertVapidPair({ publicKey: a.publicKey, privateKey: b.privateKey })),
    ).toBe('X_PWA_VAPID_KEY_INVALID');
  });

  test('a public key that is not a 65-byte point, or a scalar that is not 32 bytes, is refused', async () => {
    const pair = await generateVapidKeys();
    expect(await codeOf(() => importVapidKeys({ ...pair, publicKey: 'BAAA' }))).toBe(
      'X_PWA_VAPID_KEY_INVALID',
    );
    expect(await codeOf(() => importVapidKeys({ ...pair, privateKey: 'AAAA' }))).toBe(
      'X_PWA_VAPID_KEY_INVALID',
    );
  });

  test('the published development pair is a real pair', async () => {
    await assertVapidPair(DEV_VAPID_KEYS);
  });
});

describe('unit · which pair a process signs with', () => {
  test('development with neither variable: the published pair, said so', async () => {
    const resolved = await resolveVapidKeys({ ULTIMATE_ENV: 'development' });
    expect(resolved).toEqual({ keys: DEV_VAPID_KEYS, source: 'development' });
  });

  test('a deployed environment with neither variable is refused, naming both', async () => {
    try {
      await resolveVapidKeys({ ULTIMATE_ENV: 'production' });
      expect.unreachable('production must not sign with the published pair');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_PWA_VAPID_KEY_MISSING');
      expect((error as { meta?: { missing?: unknown } }).meta?.missing).toEqual([
        VAPID_PUBLIC_KEY_ENV,
        VAPID_PRIVATE_KEY_ENV,
      ]);
    }
  });

  test('naming no environment is production: the boot fails closed', async () => {
    expect(await codeOf(() => resolveVapidKeys({}))).toBe('X_PWA_VAPID_KEY_MISSING');
  });

  test('half a pair is refused even locally — never completed with the development half', async () => {
    const pair = await generateVapidKeys();
    expect(
      await codeOf(() =>
        resolveVapidKeys({ ULTIMATE_ENV: 'test', [VAPID_PUBLIC_KEY_ENV]: pair.publicKey }),
      ),
    ).toBe('X_PWA_VAPID_KEY_MISSING');
  });

  test('the published pair pasted into a deployed environment is refused', async () => {
    expect(
      await codeOf(() =>
        resolveVapidKeys({
          ULTIMATE_ENV: 'staging',
          [VAPID_PUBLIC_KEY_ENV]: DEV_VAPID_KEYS.publicKey,
          [VAPID_PRIVATE_KEY_ENV]: DEV_VAPID_KEYS.privateKey,
        }),
      ),
    ).toBe('X_PWA_VAPID_KEY_MISSING');
    expect(usesDevVapidKeys({ [VAPID_PRIVATE_KEY_ENV]: DEV_VAPID_KEYS.privateKey })).toBe(true);
    expect(usesDevVapidKeys({ [VAPID_PRIVATE_KEY_ENV]: ' ' })).toBe(true);
  });

  test('a real pair from the environment is used — and checked to BE a pair', async () => {
    const pair = await generateVapidKeys();
    const env = {
      ULTIMATE_ENV: 'production',
      [VAPID_PUBLIC_KEY_ENV]: pair.publicKey,
      [VAPID_PRIVATE_KEY_ENV]: pair.privateKey,
    };
    expect(await resolveVapidKeys(env)).toEqual({ keys: pair, source: 'environment' });
    expect(usesDevVapidKeys(env)).toBe(false);
    const other = await generateVapidKeys();
    expect(
      await codeOf(() => resolveVapidKeys({ ...env, [VAPID_PRIVATE_KEY_ENV]: other.privateKey })),
    ).toBe('X_PWA_VAPID_KEY_INVALID');
  });
});
