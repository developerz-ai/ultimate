// TEST-ONLY. An RSA-2048 key pair and a self-signed X.509 certificate for it, minted in-process
// with Web Crypto and hand-written DER: what a SAML IdP's metadata publishes and signs with.

export interface TestRsaSigner {
  /** Base64 DER, as `<ds:X509Certificate>` carries it. */
  readonly certificate: string;
  sign(data: string): Promise<string>;
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

const lengthOf = (n: number): Uint8Array =>
  n < 0x80 ? Uint8Array.of(n) : n < 0x100 ? Uint8Array.of(0x81, n) : Uint8Array.of(0x82, n >> 8, n);
const tlv = (tag: number, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const body = concat(parts);
  return concat([Uint8Array.of(tag), lengthOf(body.length), body]);
};
const seq = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => tlv(0x30, ...parts);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** sha256WithRSAEncryption, NULL parameters. */
const SHA256_RSA = seq(
  Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b),
  Uint8Array.of(0x05, 0x00),
);
const COMMON_NAME = Uint8Array.of(0x06, 0x03, 0x55, 0x04, 0x03);
const NAME = seq(tlv(0x31, seq(COMMON_NAME, tlv(0x0c, text('test-idp')))));
const VALIDITY = seq(tlv(0x17, text('000101000000Z')), tlv(0x18, text('20991231235959Z')));

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

export async function testRsaSigner(): Promise<TestRsaSigner> {
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1),
    hash: 'SHA-256',
  };
  const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Uint8Array.of(2))),
    tlv(0x02, Uint8Array.of(1)),
    SHA256_RSA,
    NAME,
    VALIDITY,
    NAME,
    spki,
  );
  const signRaw = async (data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, data));
  const signature = await signRaw(tbs);
  const certificate = seq(tbs, SHA256_RSA, tlv(0x03, Uint8Array.of(0), signature));
  return {
    certificate: base64(certificate),
    sign: async (data) => base64(await signRaw(new TextEncoder().encode(data))),
  };
}
