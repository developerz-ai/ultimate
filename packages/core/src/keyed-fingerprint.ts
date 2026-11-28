// Single responsibility: a fingerprint of caller input that is safe to PERSIST. `fingerprint()` is
// an unkeyed SHA-256 prefix — fine as an in-memory sharing key, but stored beside a row it is an
// offline oracle: a 6–20-digit account number or an ID number in an input, with the other fields
// known, is brute-forced from a database read.
//
// Keyed with HMAC-SHA-256, the stored value proves nothing to anyone without the app's signing
// secret.

import { canonicalJson } from './canonical-json';
import { currentSigningSecret } from './cursor';
import { hmac } from './hmac';
import { timingSafeEqual } from './timing-safe-equal';

/** The format tag. A stored value without it is no format this build reads (`unverifiable`). */
export const KEYED_FINGERPRINT_VERSION = 'h1';

/**
 * What a stored fingerprint says about an input:
 * - `match` / `mismatch` — computed under the key in force now;
 * - `unverifiable` — keyed under a secret this process does not hold (a rotation), or a format this
 *   build does not know (a bare pre-v24 hash among them). Neither confirmed nor refused.
 */
export type FingerprintMatch = 'match' | 'mismatch' | 'unverifiable';

/** Purposes are few and static; this is a backstop against a caller minting them from input. */
export const KEYED_FINGERPRINT_KEY_CACHE_MAX = 64;

interface DerivedKey {
  readonly key: string;
  readonly id: string;
}

// Module-private and never exported: the secret it is compared against stays out of anything a log
// or `x doctor` can serialise. Two hashes per call were the cost of not keeping it (realtime signs
// one cursor per subscriber per patch). A rotation is noticed by a constant-time compare (a secret), and drops
// every key derived under the old one — never a stale key.
let cachedSecret = '';
const cache = new Map<string, DerivedKey>();

/** One key per purpose, derived from the signing secret, so no two uses share a MAC key. */
function derivedKey(purpose: string): DerivedKey {
  const secret = currentSigningSecret();
  if (!timingSafeEqual(secret, cachedSecret)) {
    cache.clear();
    cachedSecret = secret;
  }
  const hit = cache.get(purpose);
  if (hit !== undefined) return hit;
  const key = hmac('sha256', secret, `ultimate:keyed-fingerprint:${purpose}`, 'hex');
  // Names the key a fingerprint was made under, so a rotation reads as `unverifiable` rather than
  // as a mismatch. 32 bits of a hash of a 256-bit derived key: a label, useless for recovering it.
  const id = new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 8);
  if (cache.size >= KEYED_FINGERPRINT_KEY_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  const derived = { key, id };
  cache.set(purpose, derived);
  return derived;
}

/** Test seam: how many purposes hold a derived key now. */
export function keyedFingerprintKeyCacheSize(): number {
  return cache.size;
}

/**
 * `h1:<key id>:<HMAC-SHA-256 over canonical JSON, 128 bits>`. `purpose` separates uses: the same
 * input fingerprints differently for two purposes. Under the shipped development secret this is as
 * public as `fingerprint()` — production boot refuses that secret (`X_CURSOR_SECRET_DEV`).
 */
export function keyedFingerprint(value: unknown, purpose: string): string {
  const { key, id } = derivedKey(purpose);
  const mac = hmac('sha256', key, canonicalJson(value), 'hex').slice(0, 32);
  return `${KEYED_FINGERPRINT_VERSION}:${id}:${mac}`;
}

/**
 * Compare a STORED fingerprint with an input. Only the keyed form is read: the unkeyed one (v23
 * and before) aged out of every store long ago, and one still lying around is `unverifiable` —
 * each caller already answers that safely (a rotation reads the same).
 */
export function compareFingerprint(
  stored: string,
  value: unknown,
  purpose: string,
): FingerprintMatch {
  const current = keyedFingerprint(value, purpose);
  const prefix = current.slice(0, current.lastIndexOf(':') + 1);
  if (!stored.startsWith(prefix)) return 'unverifiable';
  return timingSafeEqual(stored, current) ? 'match' : 'mismatch';
}
