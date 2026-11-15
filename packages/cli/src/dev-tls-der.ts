// The DER this package writes, and no more: the handful of ASN.1 types a self-signed X.509 needs
// (`dev-tls.ts`). Hand-written because the alternative is a certificate dependency or shelling out
// to openssl, and neither earns its place for one local certificate (docs/idea/18-build-vs-wrap.md).

const lengthOf = (length: number): number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
};

/** One tag-length-value; the contents already encoded. */
export const tlv = (tag: number, ...contents: readonly Uint8Array[]): Uint8Array => {
  const body = Buffer.concat(contents);
  return Uint8Array.from([tag, ...lengthOf(body.length), ...body]);
};

export const sequence = (...items: readonly Uint8Array[]): Uint8Array => tlv(0x30, ...items);
export const set = (...items: readonly Uint8Array[]): Uint8Array => tlv(0x31, ...items);
export const octets = (bytes: Uint8Array): Uint8Array => tlv(0x04, bytes);
export const utf8 = (text: string): Uint8Array => tlv(0x0c, new TextEncoder().encode(text));
/** `[n] EXPLICIT`: a constructed context tag around the encoded value. */
export const explicit = (n: number, value: Uint8Array): Uint8Array => tlv(0xa0 | n, value);
export const bitString = (bytes: Uint8Array): Uint8Array => tlv(0x03, Uint8Array.of(0), bytes);
export const bool = (value: boolean): Uint8Array => Uint8Array.of(0x01, 0x01, value ? 0xff : 0);

/** An unsigned big-endian magnitude as INTEGER: no redundant zeros, a 0x00 before a high bit. */
export const integer = (magnitude: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1;
  const trimmed = magnitude.subarray(start);
  const pad = (trimmed[0] ?? 0) & 0x80 ? Uint8Array.of(0) : new Uint8Array(0);
  return tlv(0x02, pad, trimmed);
};

/** Dotted OID, base-128 per arc after the first two. */
export const oid = (dotted: string): Uint8Array => {
  const arcs = dotted.split('.').map(Number);
  const bytes: number[] = [(arcs[0] ?? 0) * 40 + (arcs[1] ?? 0)];
  for (const arc of arcs.slice(2)) {
    const group: number[] = [arc % 128];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
      group.unshift(0x80 | (rest % 128));
    }
    bytes.push(...group);
  }
  return tlv(0x06, Uint8Array.from(bytes));
};

/** UTCTime until 2049, GeneralizedTime after — RFC 5280 §4.1.2.5, always UTC, always seconds. */
export const time = (at: Date): Uint8Array => {
  const iso = at.toISOString(); // UTC by definition: `YYYY-MM-DDTHH:MM:SS.sssZ`
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  const utc = at.getUTCFullYear() < 2050;
  return tlv(utc ? 0x17 : 0x18, new TextEncoder().encode(utc ? digits.slice(2) : digits));
};

/** WebCrypto's ECDSA signature is `r || s`; X.509 carries `SEQUENCE { INTEGER r, INTEGER s }`. */
export const ecdsaSignature = (raw: Uint8Array): Uint8Array => {
  const half = raw.length / 2;
  return sequence(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
};

/** PEM armour, 64 columns, the label as RFC 7468 spells it. */
export const pem = (label: string, der: Uint8Array): string => {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
};
