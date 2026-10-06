// Single responsibility: the public key out of a PEM X.509 certificate, as the SubjectPublicKeyInfo
// bytes Web Crypto imports (`importKey('spki', …)`). Web Crypto takes no certificate, so this walks
// just enough DER to find the seventh field of `tbsCertificate` (RFC 5280 §4.1). Malformed input is
// `undefined`, never a throw: the bytes came off a network.

interface Tlv {
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

/** One DER tag-length-value at `at`, bounded by `limit`. Definite lengths only, as DER requires. */
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

/** The DER inside the first `CERTIFICATE` block, or `undefined` for anything else. */
export function pemCertificateDer(pem: string): Uint8Array | undefined {
  const match = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/.exec(pem);
  if (match === null) return undefined;
  try {
    const binary = atob((match[1] ?? '').replace(/\s+/g, ''));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** `Certificate → tbsCertificate → subjectPublicKeyInfo`, the whole element, tag included. */
export function certificateSpki(der: Uint8Array): Uint8Array | undefined {
  const certificate = readTlv(der, 0, der.byteLength);
  if (certificate?.tag !== SEQUENCE) return undefined;
  const tbs = readTlv(der, certificate.body, certificate.end);
  if (tbs?.tag !== SEQUENCE) return undefined;
  let field = readTlv(der, tbs.body, tbs.end);
  // `[0] EXPLICIT version` is absent on a v1 certificate and present on every v3 one.
  if (field?.tag === VERSION) field = readTlv(der, field.end, tbs.end);
  for (let skipped = 0; skipped < FIELDS_BEFORE_KEY; skipped += 1) {
    if (field === undefined) return undefined;
    field = readTlv(der, field.end, tbs.end);
  }
  if (field?.tag !== SEQUENCE) return undefined;
  return der.slice(field.start, field.end);
}
