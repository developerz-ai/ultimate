// Single responsibility: the secret primitives every other file in this package shares —
// CSPRNG tokens and SHA-256 hashing. Centralised so no call site can quietly reach for `===` on
// a secret, which leaks the shared prefix length one request at a time. The constant-time
// comparison itself is `@ultimat3/core`'s `timingSafeEqual` — `@ultimat3/storage` needs the exact
// same one — imported from core by every caller, never re-exported here (`X_HELPER_COPY`).

import { finiteCount, timingSafeEqual } from '@ultimat3/core';
import { base64Url } from './base64url';

export { base64Url, base64UrlBytes } from './base64url';

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * 32 bytes -> 43 base64url chars. Opaque by construction: it encodes nothing about the user.
 *
 * The default is not a screen — `??` guards nullish and `NaN` is not nullish — and
 * `new Uint8Array(NaN)` is a zero-length array rather than a throw, so
 * `randomToken(Number(process.env.TOKEN_BYTES))` on an unset variable answered `''`: the function
 * whose entire job is an unguessable secret returning the empty string, with nothing said.
 * `-1` was a bare uncoded `RangeError` out of the package. `min: 1`, because a zero-byte token is
 * that same empty string — not a weak secret, no secret.
 *
 * `finiteCount` from core rather than this package's `assertFiniteAuthCount`: that one's refusal
 * spells the edit `defineAuth({ <key>: … })` (`errors.ts`), and there is no `defineAuth` key here —
 * the edit is at the call site, and a `fix:` naming a file that cannot hold it is worse than none.
 */
export function randomToken(byteLength = 32): string {
  return base64Url(randomBytes(finiteCount('randomToken', 'byteLength', byteLength, 1)));
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
