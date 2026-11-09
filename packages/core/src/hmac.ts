// Single responsibility: the framework's ONE keyed hash. Every HMAC a package takes — a webhook
// signature, a cursor, an OAuth cookie, a TOTP code, a keyed fingerprint — goes through `hmac()`,
// so a defect in the primitive under it is fixed in one file. `bun run keyed-hasher` refuses a
// keyed `new Bun.CryptoHasher(alg, key)` anywhere else (`X_KEYED_HASHER_OUTSIDE_CORE`).

// why: Bun 1.4.4 — after a WebCrypto EC import fails ANYWHERE in the process (one bad JWKS or
// VAPID key), the next keyed `new Bun.CryptoHasher(alg, key).update()` throws that stale OpenSSL
// error (`POINT_IS_NOT_ON_CURVE`) once. Unkeyed hashing, `crypto.subtle` HMAC and `node:crypto`'s
// `createHmac` are unaffected; Bun has no other synchronous HMAC. Pinned by `hmac.test.ts`, whose
// last test goes red when Bun fixes it.
import { createHmac } from 'node:crypto';

/** The two a caller needs: SHA-1 for TOTP (RFC 6238 requires it), SHA-256 for everything else. */
export type HmacAlgorithm = 'sha1' | 'sha256';

/** A string is its UTF-8 bytes, exactly as `Bun.CryptoHasher#update(string)` read it. */
export type HmacInput = string | Uint8Array;

export type HmacEncoding = 'hex' | 'base64' | 'base64url';

/**
 * HMAC of `data` under `key`. A LIST is the MAC over the parts' concatenation, so a canonical
 * string and a raw body are fed without joining them through a decoder. With an `encoding` the
 * digest is text; without one it is a fresh `Uint8Array` the caller owns.
 */
export function hmac(
  algorithm: HmacAlgorithm,
  key: HmacInput,
  data: HmacInput | readonly HmacInput[],
): Uint8Array;
export function hmac(
  algorithm: HmacAlgorithm,
  key: HmacInput,
  data: HmacInput | readonly HmacInput[],
  encoding: HmacEncoding,
): string;
export function hmac(
  algorithm: HmacAlgorithm,
  key: HmacInput,
  data: HmacInput | readonly HmacInput[],
  encoding?: HmacEncoding,
): Uint8Array | string {
  const mac = createHmac(algorithm, key);
  if (typeof data === 'string' || data instanceof Uint8Array) mac.update(data);
  else for (const part of data) mac.update(part);
  return encoding === undefined ? Uint8Array.from(mac.digest()) : mac.digest(encoding);
}
