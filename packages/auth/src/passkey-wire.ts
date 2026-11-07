// Single responsibility: decoding what a browser puts on the wire for a WebAuthn ceremony —
// base64url bytes, CBOR, authenticator data, the COSE public key, the DER signature and the client
// data JSON. No policy: every value here is untrusted and every rejection is X_PASSKEY_INVALID.
//
// Every byte length is capped before it is decoded. A ceremony answer is a few hundred bytes and a
// COSE key is 77; a caller that sends a megabyte is not answering a ceremony, and no parse below
// grows with its input beyond the cap.

import { isRecord } from './json';
import { passkeyInvalid } from './passkey-errors';
import { base64Url, base64UrlBytes } from './tokens';

/** A `clientDataJSON` is a few hundred bytes; anything past this is not one. */
const CLIENT_DATA_MAX_BYTES = 8_192;
/** One credential plus a COSE key, well under this. */
const ATTESTATION_MAX_BYTES = 65_536;
/** An ECDSA signature is 64 bytes raw, ~72 DER. */
const SIGNATURE_MAX_BYTES = 512;
/** COSE identifiers, RFC 9053. */
const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;
/** Authenticator-data flags, WebAuthn §6.1. */
const FLAG_ATTESTED_CREDENTIAL = 0x40;
const AUTHENTICATOR_DATA_MIN_BYTES = 37;
const CBOR_MAX_DEPTH = 8;

/** A function DECLARATION, not a `const` arrow: only this form narrows what follows an `if`. */
function refuse(detail: string): never {
  throw passkeyInvalid(detail);
}

/** A base64url field, decoded, refused when it is missing, malformed, empty or over its cap. */
export function wireBytes(
  value: unknown,
  field: string,
  maxBytes: number,
): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value === '')
    refuse(`${field} is missing or is not a base64url string`);
  const bytes = base64UrlBytes(value);
  if (bytes === null) refuse(`${field} is not valid base64url`);
  if (bytes.length === 0 || bytes.length > maxBytes) {
    refuse(`${field} is ${String(bytes.length)} bytes, outside 1..${String(maxBytes)}`);
  }
  return bytes;
}

export const clientDataBytes = (value: unknown): Uint8Array<ArrayBuffer> =>
  wireBytes(value, 'clientDataJSON', CLIENT_DATA_MAX_BYTES);

export const attestationBytes = (value: unknown): Uint8Array<ArrayBuffer> =>
  wireBytes(value, 'attestationObject', ATTESTATION_MAX_BYTES);

export const authenticatorBytes = (value: unknown): Uint8Array<ArrayBuffer> =>
  wireBytes(value, 'authenticatorData', ATTESTATION_MAX_BYTES);

export const signatureField = (value: unknown): Uint8Array<ArrayBuffer> =>
  wireBytes(value, 'signature', SIGNATURE_MAX_BYTES);

export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const uint = (bytes: Uint8Array, at: number, width: number): number => {
  let value = 0;
  for (let index = 0; index < width; index += 1) value = value * 256 + (bytes[at + index] ?? 0);
  return value;
};

// ── CBOR: the two maps WebAuthn puts in front of a public key ──────────────────────────────────

function cborHead(bytes: Uint8Array, cursor: { at: number }): { major: number; value: number } {
  if (cursor.at >= bytes.length) refuse('the CBOR map ended before its header');
  const initial = bytes[cursor.at] ?? 0;
  cursor.at += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) return { major, value: info };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (width === 0)
    refuse(
      `the CBOR map uses indefinite length (0x${info.toString(16)}), which WebAuthn never emits`,
    );
  if (cursor.at + width > bytes.length) refuse('the CBOR map ended inside a length');
  const value = uint(bytes, cursor.at, width);
  cursor.at += width;
  return { major, value };
}

function cborItem(bytes: Uint8Array, cursor: { at: number }, depth: number): unknown {
  if (depth > CBOR_MAX_DEPTH) refuse('the CBOR map nests deeper than any WebAuthn structure');
  const { major, value } = cborHead(bytes, cursor);
  if (major === 0) return value;
  if (major === 1) return -1 - value;
  if (major === 2 || major === 3) {
    if (cursor.at + value > bytes.length) refuse('the CBOR map ended inside a string');
    const slice = bytes.subarray(cursor.at, cursor.at + value);
    cursor.at += value;
    return major === 2 ? slice : new TextDecoder().decode(slice);
  }
  if (major === 4) {
    const items: unknown[] = [];
    for (let index = 0; index < value; index += 1) items.push(cborItem(bytes, cursor, depth + 1));
    return items;
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>();
    for (let index = 0; index < value; index += 1) {
      const key = cborItem(bytes, cursor, depth + 1);
      map.set(key, cborItem(bytes, cursor, depth + 1));
    }
    return map;
  }
  // Text and byte strings are the only majors left that WebAuthn emits (`major 7` simple values
  // never appear in an attestation object or a COSE key), so anything else is refused.
  return refuse(`the CBOR map holds major type ${String(major)}, which no WebAuthn structure uses`);
}

export const cborMap = (bytes: Uint8Array): Map<unknown, unknown> => {
  const item = cborItem(bytes, { at: 0 }, 0);
  if (!(item instanceof Map)) refuse('the structure is not a CBOR map');
  return item;
};

// ── authenticator data, and the COSE key inside it ─────────────────────────────────────────────

export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: number;
  readonly signCount: number;
  /** base64url, present only on a create ceremony (the `AT` flag). */
  readonly credentialId: string | null;
  readonly publicKeyCose: string | null;
}

export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < AUTHENTICATOR_DATA_MIN_BYTES) {
    refuse(
      `the authenticator data is ${String(bytes.length)} bytes, shorter than the rpIdHash, flags and counter it must carry`,
    );
  }
  const flags = bytes[32] ?? 0;
  const base: AuthenticatorData = {
    rpIdHash: bytes.subarray(0, 32),
    flags,
    signCount: uint(bytes, 33, 4),
    credentialId: null,
    publicKeyCose: null,
  };
  if ((flags & FLAG_ATTESTED_CREDENTIAL) === 0) return base;
  // aaguid(16) | credentialIdLength(2) | credentialId | the CBOR-encoded COSE key.
  if (bytes.length < 55) refuse('the attested credential data is truncated');
  const idLength = uint(bytes, 53, 2);
  if (idLength === 0 || 55 + idLength >= bytes.length) {
    refuse(`the attested credential id is ${String(idLength)} bytes, which fits nothing`);
  }
  return {
    ...base,
    credentialId: base64Url(bytes.subarray(55, 55 + idLength)),
    publicKeyCose: base64Url(bytes.subarray(55 + idLength)),
  };
}

/** The COSE key as the JWK WebCrypto imports. Anything but ES256/P-256 is refused, never guessed. */
export function coseToJwk(publicKeyCose: string): JsonWebKey {
  const map = cborMap(wireBytes(publicKeyCose, 'publicKeyCose', ATTESTATION_MAX_BYTES));
  const x = map.get(-2);
  const y = map.get(-3);
  if (
    map.get(1) !== COSE_KTY_EC2 ||
    map.get(3) !== COSE_ALG_ES256 ||
    map.get(-1) !== COSE_CRV_P256
  ) {
    refuse(
      'the credential public key is not an ES256 P-256 key, and ES256 is the only algorithm this ceremony offers',
    );
  }
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array))
    refuse('the credential public key has no x/y coordinates');
  if (x.length !== 32 || y.length !== 32) refuse('the credential public key is not a P-256 point');
  return { kty: 'EC', crv: 'P-256', x: base64Url(x), y: base64Url(y), ext: false };
}

/**
 * A browser sends an ECDSA signature ASN.1/DER encoded and WebCrypto takes `r‖s`. 64 bytes is
 * already `r‖s` — what `crypto.subtle.sign` answers — so it is passed through, never refused.
 */
export function signatureBytes(signature: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (signature.length === 64) return signature;
  if (signature.length < 8 || signature[0] !== 0x30) {
    refuse(
      `the signature is ${String(signature.length)} bytes and neither DER nor a 64-byte ES256 pair`,
    );
  }
  let at = 2;
  const readInteger = (): Uint8Array => {
    if ((signature[at] ?? 0) !== 0x02)
      refuse('the signature is not a DER SEQUENCE of two INTEGERs');
    const length = signature[at + 1] ?? 0;
    if (length === 0 || at + 2 + length > signature.length)
      refuse('a DER INTEGER in the signature runs past its end');
    const value = signature.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    // DER pads a positive value with 0x00 so it does not read as negative; `r‖s` is unsigned.
    const trimmed = value.length > 32 && value[0] === 0x00 ? value.subarray(1) : value;
    if (trimmed.length > 32) refuse('a DER INTEGER in the signature is wider than P-256');
    const out = new Uint8Array(32);
    out.set(trimmed, 32 - trimmed.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(readInteger(), 0);
  raw.set(readInteger(), 32);
  return raw;
}

// ── client data ────────────────────────────────────────────────────────────────────────────────

export interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  /** Byte-identical to what arrived: this is what the signature covers. */
  readonly raw: string;
}

export function parseClientData(bytes: Uint8Array): ClientData {
  const raw = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse('the client data is not JSON');
  }
  if (!isRecord(parsed)) refuse('the client data is not a JSON object');
  const { type, challenge, origin } = parsed;
  if (typeof type !== 'string' || typeof challenge !== 'string' || typeof origin !== 'string') {
    refuse('the client data is missing its type, challenge or origin');
  }
  return { type, challenge, origin, raw };
}
