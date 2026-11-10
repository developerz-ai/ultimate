// Single responsibility: an IdP's X.509 signing certificate (base64 DER, as metadata carries it)
// → the RSA public key Web Crypto verifies with. Web Crypto takes no certificate, so this walks
// just enough DER to lift `subjectPublicKeyInfo` out of `tbsCertificate` (RFC 5280 §4.1).
// Only the key is trusted: the certificate's dates and issuer are the metadata's business.

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

const SEQUENCE = 0x30;
const VERSION = 0xa0;
/** `serialNumber`, `signature`, `issuer`, `validity`, `subject` — skipped to reach the key. */
const FIELDS_BEFORE_KEY = 5;
/** NIST SP 800-131A: an RSA key under 2048 bits signs nothing an SP should believe. */
export const MIN_SAML_RSA_BITS = 2048;

function readTlv(bytes: Uint8Array, at: number, limit: number): Tlv | undefined {
  if (at + 2 > limit) return undefined;
  const tag = bytes[at] ?? 0;
  const first = bytes[at + 1] ?? 0;
  let body = at + 2;
  let length = first;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || body + count > limit) return undefined;
    length = 0;
    for (let index = 0; index < count; index += 1)
      length = length * 256 + (bytes[body + index] ?? 0);
    body += count;
  }
  const end = body + length;
  return end > limit ? undefined : { tag, start: at, body, end };
}

/** Strict base64 with the white space metadata wraps it in; `undefined` for anything else. */
export function base64Bytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  const compact = text.replace(/[ \t\r\n]+/g, '');
  if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return undefined;
  }
  const binary = atob(compact);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** `Certificate → tbsCertificate → subjectPublicKeyInfo`, tag included, or `undefined`. */
export function certificateSpki(base64Der: string): Uint8Array<ArrayBuffer> | undefined {
  const der = base64Bytes(base64Der);
  if (der === undefined) return undefined;
  const certificate = readTlv(der, 0, der.byteLength);
  if (certificate?.tag !== SEQUENCE || certificate.end !== der.byteLength) return undefined;
  const tbs = readTlv(der, certificate.body, certificate.end);
  if (tbs?.tag !== SEQUENCE) return undefined;
  let field = readTlv(der, tbs.body, tbs.end);
  if (field?.tag === VERSION) field = readTlv(der, field.end, tbs.end);
  for (let skipped = 0; skipped < FIELDS_BEFORE_KEY; skipped += 1) {
    if (field === undefined) return undefined;
    field = readTlv(der, field.end, tbs.end);
  }
  if (field?.tag !== SEQUENCE) return undefined;
  return der.slice(field.start, field.end);
}

/**
 * The verification key for RSA-SHA256, or `undefined` for a certificate that is unreadable, not
 * RSA, or under `MIN_SAML_RSA_BITS`. The caller names the refusal; this file throws nothing.
 */
export async function samlVerifyKey(base64Der: string): Promise<CryptoKey | undefined> {
  const spki = certificateSpki(base64Der);
  if (spki === undefined) return undefined;
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const { modulusLength } = key.algorithm as RsaHashedKeyAlgorithm;
    return modulusLength >= MIN_SAML_RSA_BITS ? key : undefined;
  } catch {
    return undefined;
  }
}
