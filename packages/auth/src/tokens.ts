// Single responsibility: the secret primitives every other file in this package shares —
// CSPRNG tokens and SHA-256 hashing. Centralised so no call site can quietly reach for `===` on
// a secret, which leaks the shared prefix length one request at a time. The constant-time
// comparison itself lives in `@ultimat3/core` (`timingSafeEqual`) — `@ultimat3/storage` needs the
// exact same one, and re-exporting it here keeps every existing `from '@ultimat3/auth'` import
// working.

import { timingSafeEqual } from '@ultimat3/core';

export { timingSafeEqual };

const BASE64URL_UNSAFE = /[+/=]/g;
const BASE64URL_REPLACEMENTS: Readonly<Record<string, string>> = { '+': '-', '/': '_', '=': '' };

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(BASE64URL_UNSAFE, (char) => BASE64URL_REPLACEMENTS[char] ?? '');
}

/** 32 bytes -> 43 base64url chars. Opaque by construction: it encodes nothing about the user. */
export function randomToken(byteLength = 32): string {
  return base64Url(randomBytes(byteLength));
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

export function sha256Bytes(value: string): Uint8Array {
  return Uint8Array.from(new Bun.CryptoHasher('sha256').update(value).digest());
}

/** Hash-then-compare. The plaintext never has to be held next to the stored value. */
export function matchesHash(plaintext: string, storedHash: string): boolean {
  return timingSafeEqual(sha256Hex(plaintext), storedHash);
}
