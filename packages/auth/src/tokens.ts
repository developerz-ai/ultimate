// Single responsibility: the secret primitives every other file in this package shares —
// CSPRNG tokens, SHA-256 hashing and a comparison whose duration does not depend on where
// two strings first differ. Centralised so no call site can quietly reach for `===` on a
// secret, which leaks the shared prefix length one request at a time.

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

/**
 * Length is compared first and non-constant-time on purpose: every secret this package
 * compares is a fixed-width hash or token, so the length carries no information, and the
 * XOR accumulator below is what has to be branch-free.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/** Hash-then-compare. The plaintext never has to be held next to the stored value. */
export function matchesHash(plaintext: string, storedHash: string): boolean {
  return timingSafeEqual(sha256Hex(plaintext), storedHash);
}
