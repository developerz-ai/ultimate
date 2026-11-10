// Single responsibility: the one DER walk the framework owns — an X.509 certificate's
// `subjectPublicKeyInfo` (RFC 5280 §4.1), the bytes Web Crypto's `importKey('spki', …)` takes,
// because Web Crypto takes no certificate. SAML's IdP key and SNS's signing key both read it here.
// Malformed input is `undefined`, never a throw: the bytes came off a network.

/** One DER tag-length-value. Offsets index the buffer it was read from. */
export interface DerTlv {
  readonly tag: number;
  /** Offset of the tag byte. */
  readonly start: number;
  /** Offset of the first content byte. */
  readonly body: number;
  /** Offset one past the last content byte. */
  readonly end: number;
}

const SEQUENCE = 0x30;
const VERSION = 0xa0;
/** `serialNumber`, `signature`, `issuer`, `validity`, `subject` — skipped to reach the key. */
const FIELDS_BEFORE_KEY = 5;
/** Four length octets reach 4 GiB; no certificate is longer, and more would overflow nothing useful. */
const MAX_LENGTH_OCTETS = 4;

/**
 * The TLV at `at`, its content bounded by `limit`. Definite lengths only, as DER requires: the
 * indefinite form (`0x80`) and a length running past `limit` are `undefined`.
 */
export function readDerTlv(bytes: Uint8Array, at: number, limit: number): DerTlv | undefined {
  if (at + 2 > limit) return undefined;
  const tag = bytes[at] ?? 0;
  const first = bytes[at + 1] ?? 0;
  let body = at + 2;
  let length = first;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > MAX_LENGTH_OCTETS || body + count > limit) return undefined;
    length = 0;
    for (let index = 0; index < count; index += 1)
      length = length * 256 + (bytes[body + index] ?? 0);
    body += count;
  }
  const end = body + length;
  return end > limit ? undefined : { tag, start: at, body, end };
}

/**
 * `Certificate → tbsCertificate → subjectPublicKeyInfo`, the whole element, tag included — or
 * `undefined` when `der` is not exactly one certificate (trailing bytes included: DER is exact).
 * Only the key is read; dates, issuer and signature are the caller's business.
 */
export function x509Spki(der: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  const certificate = readDerTlv(der, 0, der.byteLength);
  if (certificate?.tag !== SEQUENCE || certificate.end !== der.byteLength) return undefined;
  const tbs = readDerTlv(der, certificate.body, certificate.end);
  if (tbs?.tag !== SEQUENCE) return undefined;
  let field = readDerTlv(der, tbs.body, tbs.end);
  // `[0] EXPLICIT version` is absent on a v1 certificate and present on every v3 one.
  if (field?.tag === VERSION) field = readDerTlv(der, field.end, tbs.end);
  for (let skipped = 0; skipped < FIELDS_BEFORE_KEY; skipped += 1) {
    if (field === undefined) return undefined;
    field = readDerTlv(der, field.end, tbs.end);
  }
  if (field?.tag !== SEQUENCE) return undefined;
  return der.slice(field.start, field.end);
}
