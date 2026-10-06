// The DER walk that gets SNS's public key out of its certificate. The well-formed half is proven
// against openssl when the fixture was built (`openssl x509 -pubkey` gave the same SPKI); here,
// that it finds the key in v1 and v3 certificates and answers `undefined` for anything malformed.

import { describe, expect, test } from 'bun:test';
import { snsSigner } from './delivery-event-fixture';
import { certificateSpki, pemCertificateDer } from './x509-spki';

describe('certificateSpki', () => {
  test('finds the same key in an X.509 v3 and a v1 certificate, and Web Crypto imports it', async () => {
    const signer = await snsSigner();
    const v3 = certificateSpki(pemCertificateDer(signer.certificatePem) ?? new Uint8Array());
    const v1 = certificateSpki(pemCertificateDer(signer.v1CertificatePem) ?? new Uint8Array());
    if (v3 === undefined || v1 === undefined) return expect.unreachable('no key found');
    expect(v1).toEqual(v3);
    const key = await crypto.subtle.importKey(
      'spki',
      new Uint8Array(v3),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify'],
    );
    expect(key.type).toBe('public');
  });

  test('every truncation of a real certificate is undefined, never a throw', async () => {
    const der = pemCertificateDer((await snsSigner()).certificatePem) ?? new Uint8Array();
    for (let length = 0; length < der.byteLength; length += 1) {
      expect(certificateSpki(der.slice(0, length))).toBeUndefined();
    }
  });

  test.each([
    ['empty', Uint8Array.of()],
    ['not a sequence', Uint8Array.of(0x02, 0x01, 0x00)],
    ['indefinite length', Uint8Array.of(0x30, 0x80, 0x00, 0x00)],
    ['length past the end', Uint8Array.of(0x30, 0x84, 0xff, 0xff, 0xff, 0xff)],
  ])('%s is undefined', (_name, bytes) => {
    expect(certificateSpki(bytes)).toBeUndefined();
  });
});

describe('pemCertificateDer', () => {
  test.each([
    ['no armour', 'MIIB'],
    ['a private key block', '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'],
    ['bad base64', '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----'],
  ])('%s is undefined', (_name, pem) => {
    expect(pemCertificateDer(pem)).toBeUndefined();
  });
});
