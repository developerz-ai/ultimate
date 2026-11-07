// TEST-ONLY. A self-signed TLS certificate for one DNS name, minted in-process: a WebCrypto P-256
// key and the X.509 DER written by hand. A test that needs a real TLS listener then shells out to
// no `openssl` — whose mint, on a loaded Windows runner, outlasted a 30 s bound and was killed.

export interface SelfSignedCert {
  /** PEM `CERTIFICATE`: both the listener's certificate and the client's only trusted root. */
  readonly cert: string;
  /** PEM `PRIVATE KEY` (PKCS #8). */
  readonly key: string;
}

const concat = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** DER length octets: short form below 128, long form up to 64 KiB — a certificate is far less. */
const lengthOf = (n: number): Uint8Array =>
  n < 0x80 ? Uint8Array.of(n) : n < 0x100 ? Uint8Array.of(0x81, n) : Uint8Array.of(0x82, n >> 8, n);

const tlv = (tag: number, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const body = concat(parts);
  return concat([Uint8Array.of(tag), lengthOf(body.length), body]);
};
const seq = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => tlv(0x30, ...parts);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A non-negative INTEGER from big-endian magnitude bytes: leading zeros dropped, sign octet added. */
const integer = (magnitude: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const trimmed = magnitude.subarray(start);
  const signed = (trimmed[0] ?? 0) >= 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed;
  return tlv(0x02, signed);
};

/** Pre-encoded OBJECT IDENTIFIERs. */
const ECDSA_WITH_SHA256 = Uint8Array.of(0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const COMMON_NAME = Uint8Array.of(0x06, 0x03, 0x55, 0x04, 0x03);
const SUBJECT_ALT_NAME = Uint8Array.of(0x06, 0x03, 0x55, 0x1d, 0x11);
const BASIC_CONSTRAINTS = Uint8Array.of(0x06, 0x03, 0x55, 0x1d, 0x13);
const TRUE = Uint8Array.of(0x01, 0x01, 0xff);

/**
 * Valid 2000 through 2099, fixed: TLS checks validity against the REAL clock, which the test
 * preload's frozen `Date` does not move, so the window must hold whenever the suite runs.
 */
const VALIDITY = seq(tlv(0x17, text('000101000000Z')), tlv(0x18, text('20991231235959Z')));

/** WebCrypto signs ECDSA as `r || s`; X.509 carries `SEQUENCE { INTEGER r, INTEGER s }`. */
const derSignature = (raw: Uint8Array): Uint8Array => {
  const half = raw.length / 2;
  return seq(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
};

const pem = (label: string, der: Uint8Array): string => {
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
};

/** Mint a certificate whose subject CN and only subjectAltName are `dnsName`. */
export async function selfSignedCert(dnsName: string): Promise<SelfSignedCert> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const name = seq(tlv(0x31, seq(COMMON_NAME, tlv(0x0c, text(dnsName)))));
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const extensions = tlv(
    0xa3,
    seq(
      seq(SUBJECT_ALT_NAME, tlv(0x04, seq(tlv(0x82, text(dnsName))))),
      seq(BASIC_CONSTRAINTS, TRUE, tlv(0x04, seq(TRUE))),
    ),
  );
  const algorithm = seq(ECDSA_WITH_SHA256);
  const tbs = seq(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(serial),
    algorithm,
    name,
    VALIDITY,
    name,
    spki,
    extensions,
  );
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, tbs),
  );
  const cert = seq(tbs, algorithm, tlv(0x03, Uint8Array.of(0), derSignature(raw)));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { cert: pem('CERTIFICATE', cert), key: pem('PRIVATE KEY', pkcs8) };
}
