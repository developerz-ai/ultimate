// Single responsibility: the two structures every WebAuthn ceremony signs over, read from the
// bytes the browser forwarded — `authenticatorData` (W3C WebAuthn L3 §6.1) and `clientDataJSON`
// (§5.8.1). Parsing only: what each field must equal is `passkey-verify.ts`'s to decide.

import { canonicalBase64UrlBytes } from './base64url';
import { type CborValue, decodeCborItem } from './cbor';
import { isRecord } from './json';

/** User Present, User Verified, Attested credential data, Extension data (§6.1 flags). */
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

/** Longer than this is not a credential id an authenticator mints (§5.8.3, 1023 bytes). */
const MAX_CREDENTIAL_ID_BYTES = 1023;

export interface AttestedCredential {
  readonly aaguid: Uint8Array;
  readonly credentialId: Uint8Array;
  /** The COSE_Key exactly as the authenticator encoded it — what is stored and re-imported. */
  readonly publicKey: Uint8Array;
}

export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: number;
  readonly signCount: number;
  readonly attested: AttestedCredential | null;
}

/** `null` for a truncated buffer, trailing bytes, or an attested key that is not one CBOR item. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData | null {
  if (bytes.length < 37) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32] ?? 0;
  const signCount = view.getUint32(33);
  let at = 37;
  let attested: AttestedCredential | null = null;
  if ((flags & FLAG_AT) !== 0) {
    if (bytes.length < at + 18) return null;
    const aaguid = bytes.slice(at, at + 16);
    const idLength = view.getUint16(at + 16);
    at += 18;
    if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES || at + idLength > bytes.length) {
      return null;
    }
    const credentialId = bytes.slice(at, at + idLength);
    at += idLength;
    const key = decodeCborItem(bytes, at);
    if (key === null || !(key.value instanceof Map)) return null;
    attested = { aaguid, credentialId, publicKey: bytes.slice(at, key.end) };
    at = key.end;
  }
  if ((flags & FLAG_ED) !== 0) {
    const extensions = decodeCborItem(bytes, at);
    if (extensions === null || !(extensions.value instanceof Map)) return null;
    at = extensions.end;
  }
  if (at !== bytes.length) return null;
  return { rpIdHash: bytes.slice(0, 32), flags, signCount, attested };
}

export interface ClientData {
  readonly type: string;
  /** The challenge as the browser echoed it: base64url TEXT, compared as text. */
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin: boolean;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** `null` unless the bytes are UTF-8 JSON carrying the four fields, each of its type. */
export function parseClientData(bytes: Uint8Array): ClientData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { type, challenge, origin, crossOrigin } = parsed;
  if (typeof type !== 'string' || typeof origin !== 'string') return null;
  if (canonicalBase64UrlBytes(challenge) === null || typeof challenge !== 'string') return null;
  if (crossOrigin !== undefined && typeof crossOrigin !== 'boolean') return null;
  return { type, challenge, origin, crossOrigin: crossOrigin === true };
}

export interface AttestationObject {
  readonly fmt: string;
  readonly authData: Uint8Array;
}

/**
 * The attestation object's `fmt` and `authData`. `attStmt` is read for shape and NOT verified:
 * registration asks for `attestation: 'none'`, so no statement is trusted for anything — the
 * credential's key is bound by the signed challenge of every later assertion, not by its vendor.
 */
export function parseAttestationObject(bytes: Uint8Array): AttestationObject | null {
  const decoded = decodeCborItem(bytes);
  if (decoded === null || decoded.end !== bytes.length || !(decoded.value instanceof Map)) {
    return null;
  }
  const map: ReadonlyMap<number | string, CborValue> = decoded.value;
  const fmt = map.get('fmt');
  const authData = map.get('authData');
  if (typeof fmt !== 'string' || !(authData instanceof Uint8Array)) return null;
  if (!(map.get('attStmt') instanceof Map)) return null;
  return { fmt, authData };
}
