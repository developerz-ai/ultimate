// Single responsibility: a fingerprint of caller input that is safe to PERSIST. `fingerprint()` is
// an unkeyed SHA-256 prefix — fine as an in-memory sharing key, but stored beside a row it is an
// offline oracle: a 6–20-digit account number or an ID number in an input, with the other fields
// known, is brute-forced from a database read. Keyed with HMAC-SHA-256, the stored value proves
// nothing to anyone without the app's signing secret.

import { canonicalJson, fingerprint } from './canonical-json';
import { currentSigningSecret } from './cursor';
import { timingSafeEqual } from './timing-safe-equal';

/** The format tag. A stored value without it predates keying (see `compareFingerprint`). */
export const KEYED_FINGERPRINT_VERSION = 'h1';

/**
 * What a stored fingerprint says about an input:
 * - `match` / `mismatch` — computed under the key in force now (or the legacy unkeyed form);
 * - `unverifiable` — keyed under a secret this process does not hold (a rotation), or a format this
 *   build does not know. The input can be neither confirmed nor refused.
 */
export type FingerprintMatch = 'match' | 'mismatch' | 'unverifiable';

const LEGACY = /^[0-9a-f]{16}$/;

/** One key per purpose, derived from the signing secret, so no two uses share a MAC key. */
function derivedKey(purpose: string): string {
  return new Bun.CryptoHasher('sha256', currentSigningSecret())
    .update(`ultimate:keyed-fingerprint:${purpose}`)
    .digest('hex');
}

/**
 * Names the key a fingerprint was made under, so a rotation reads as `unverifiable` rather than as
 * a mismatch. 32 bits of a hash of a 256-bit derived key: a label, useless for recovering it.
 */
function keyId(key: string): string {
  return new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * `h1:<key id>:<HMAC-SHA-256 over canonical JSON, 128 bits>`. `purpose` separates uses: the same
 * input fingerprints differently for two purposes. Under the shipped development secret this is as
 * public as `fingerprint()` — production boot refuses that secret (`X_CURSOR_SECRET_DEV`).
 */
export function keyedFingerprint(value: unknown, purpose: string): string {
  const key = derivedKey(purpose);
  const mac = new Bun.CryptoHasher('sha256', key)
    .update(canonicalJson(value))
    .digest('hex')
    .slice(0, 32);
  return `${KEYED_FINGERPRINT_VERSION}:${keyId(key)}:${mac}`;
}

/**
 * Compare a STORED fingerprint with an input. A legacy unkeyed value (16 hex characters, written by
 * a build before keying) is checked against `fingerprint()` computed here and never stored, so rows
 * written across an upgrade keep their exact semantics until they age out.
 */
export function compareFingerprint(
  stored: string,
  value: unknown,
  purpose: string,
): FingerprintMatch {
  if (LEGACY.test(stored))
    return timingSafeEqual(stored, fingerprint(value)) ? 'match' : 'mismatch';
  const current = keyedFingerprint(value, purpose);
  const prefix = current.slice(0, current.lastIndexOf(':') + 1);
  if (!stored.startsWith(prefix)) return 'unverifiable';
  return timingSafeEqual(stored, current) ? 'match' : 'mismatch';
}
