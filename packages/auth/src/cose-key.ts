// Single responsibility: a COSE_Key (RFC 9053) a passkey registered, as a WebCrypto key that can
// check its signatures — ES256 (P-256, the algorithm every platform authenticator uses) and RS256
// (Windows Hello's). The algorithm comes from the KEY, never from the assertion: a signature cannot
// choose how it is checked. Every malformed input answers `null`; the caller owns the refusal.

import { base64Url } from './base64url';
import { type CborValue, decodeCbor } from './cbor';

/** COSE algorithm identifiers this package verifies. Offered in this order at registration. */
export const COSE_ES256 = -7;
export const COSE_RS256 = -257;
export const PASSKEY_ALGORITHMS: readonly number[] = Object.freeze([COSE_ES256, COSE_RS256]);

const KTY_EC2 = 2;
const KTY_RSA = 3;
const CRV_P256 = 1;
/** RSA keys below this are not a credential anybody should accept in 2026. */
const MIN_RSA_MODULUS_BYTES = 256;

export interface PasskeyPublicKey {
  readonly algorithm: number;
  readonly key: CryptoKey;
}

const bytesAt = (
  map: ReadonlyMap<number | string, CborValue>,
  label: number,
): Uint8Array | null => {
  const value = map.get(label);
  return value instanceof Uint8Array ? value : null;
};

/** The stored COSE bytes as a verifying key, or `null` when they are not one this package checks. */
export async function importCoseKey(cose: Uint8Array): Promise<PasskeyPublicKey | null> {
  const decoded = decodeCbor(cose);
  if (!(decoded instanceof Map)) return null;
  const kty = decoded.get(1);
  const algorithm = decoded.get(3);
  try {
    if (kty === KTY_EC2 && algorithm === COSE_ES256) {
      const x = bytesAt(decoded, -2);
      const y = bytesAt(decoded, -3);
      if (decoded.get(-1) !== CRV_P256 || x?.length !== 32 || y?.length !== 32) return null;
      const jwk = { kty: 'EC', crv: 'P-256', x: base64Url(x), y: base64Url(y) };
      const key = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      return { algorithm, key };
    }
    if (kty === KTY_RSA && algorithm === COSE_RS256) {
      const n = bytesAt(decoded, -1);
      const e = bytesAt(decoded, -2);
      if (n === null || e === null || n.length < MIN_RSA_MODULUS_BYTES || e.length === 0) {
        return null;
      }
      const jwk = { kty: 'RSA', n: base64Url(n), e: base64Url(e) };
      const key = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      return { algorithm, key };
    }
  } catch {
    // A point off the curve, or a modulus WebCrypto refuses: not a key.
    return null;
  }
  return null;
}

/** `false` for every failure, the malformed signature included — never a throw on foreign bytes. */
export async function verifyCoseSignature(
  checker: PasskeyPublicKey,
  signature: Uint8Array,
  signed: Uint8Array,
): Promise<boolean> {
  try {
    if (checker.algorithm === COSE_ES256) {
      const raw = ecdsaDerToRaw(signature);
      if (raw === null) return false;
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        checker.key,
        raw,
        new Uint8Array(signed),
      );
    }
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      checker.key,
      new Uint8Array(signature),
      new Uint8Array(signed),
    );
  } catch {
    return false;
  }
}

/**
 * An authenticator's ES256 signature is ASN.1 DER — `SEQUENCE { INTEGER r, INTEGER s }` — and
 * WebCrypto checks the raw 64-byte `r || s`. Strict DER: minimal lengths, no trailing bytes, each
 * integer positive and at most 32 bytes once its sign byte is dropped.
 */
export function ecdsaDerToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const raw = new Uint8Array(64);
  let at = 2;
  for (const offset of [0, 32]) {
    if (der[at] !== 0x02) return null;
    const length = der[at + 1] ?? 0;
    const start = at + 2;
    if (length === 0 || length > 33 || start + length > der.length) return null;
    let integer = der.subarray(start, start + length);
    // Negative, or a leading zero the next byte did not need: not DER.
    if ((integer[0] ?? 0) & 0x80) return null;
    if (integer[0] === 0 && integer.length > 1 && ((integer[1] ?? 0) & 0x80) === 0) return null;
    if (integer[0] === 0 && integer.length > 1) integer = integer.subarray(1);
    if (integer.length > 32) return null;
    raw.set(integer, offset + 32 - integer.length);
    at = start + length;
  }
  return at === der.length ? raw : null;
}
