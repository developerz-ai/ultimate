// `hmac()` against the published vectors, and against the Bun bug it exists to route around: a
// failed WebCrypto EC import leaves an OpenSSL error behind that the NEXT keyed `Bun.CryptoHasher`
// in the process throws. The helper must survive it; the raw hasher is pinned to still fail, so
// this suite turns red the day Bun fixes it — then delete the pin and the `why:` in `hmac.ts`.

import { describe, expect, test } from 'bun:test';
import { hmac } from './hmac';

/** A JWK whose point is not on P-256: `importKey` rejects it, and leaves the error queued. */
const BAD_EC = { kty: 'EC', crv: 'P-256', d: 'AAAA', x: 'AAAA', y: 'AAAA' };

async function failEcImport(): Promise<void> {
  const imported = await crypto.subtle
    .importKey('jwk', BAD_EC, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    .then(
      () => true,
      () => false,
    );
  expect(imported).toBe(false);
}

/** The raw hasher, once: whether the stale error was still queued for it. Consumes it if it was. */
function rawKeyedHasherThrows(): boolean {
  try {
    new Bun.CryptoHasher('sha256', 'key').update('data').digest('hex');
    return false;
  } catch {
    return true;
  }
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('hmac', () => {
  // RFC 4231 test case 2 and RFC 2202 test case 2: key "Jefe".
  const JEFE = 'what do ya want for nothing?';

  test('HMAC-SHA-256 and HMAC-SHA-1 answer the RFC vectors', () => {
    expect(hmac('sha256', 'Jefe', JEFE, 'hex')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(hex(hmac('sha1', 'Jefe', JEFE))).toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
  });

  test('a byte key and byte data are the same MAC as their UTF-8 text', () => {
    const key = new TextEncoder().encode('Jefe');
    expect(hmac('sha256', key, new TextEncoder().encode(JEFE), 'hex')).toBe(
      hmac('sha256', 'Jefe', JEFE, 'hex'),
    );
  });

  test('a list of parts is the MAC over their concatenation', () => {
    const parts = ['what do ya ', new TextEncoder().encode('want for '), 'nothing?'];
    expect(hmac('sha256', 'Jefe', parts, 'hex')).toBe(hmac('sha256', 'Jefe', JEFE, 'hex'));
  });

  test('every encoding is the bytes, encoded', () => {
    const bytes = hmac('sha256', 'Jefe', JEFE);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(32);
    expect(hmac('sha256', 'Jefe', JEFE, 'base64')).toBe(Buffer.from(bytes).toString('base64'));
    expect(hmac('sha256', 'Jefe', JEFE, 'base64url')).toBe(
      Buffer.from(bytes).toString('base64url'),
    );
  });

  test('the bytes are a copy: writing to one answer changes no other', () => {
    const first = hmac('sha256', 'Jefe', JEFE);
    first.fill(0);
    expect(hex(hmac('sha256', 'Jefe', JEFE))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('after a failed WebCrypto EC import', () => {
  test('hmac() still answers, and the right MAC', async () => {
    await failEcImport();
    expect(hmac('sha256', 'Jefe', 'what do ya want for nothing?', 'hex')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    // Drain whatever is still queued, so no later suite in this process inherits it.
    rawKeyedHasherThrows();
  });

  // BUN BUG PIN (Bun 1.4.4). Red means Bun FIXED it: delete this test and the `why:` in `hmac.ts`
  // — the helper can stay, it is still the one keyed hash (`bun run keyed-hasher`).
  test('the raw keyed Bun.CryptoHasher still throws the stale error, once', async () => {
    await failEcImport();
    expect(rawKeyedHasherThrows()).toBe(true);
    expect(rawKeyedHasherThrows()).toBe(false);
  });
});
