// SNS's public key out of its PEM certificate. The well-formed half is proven against openssl when
// the fixture was built (`openssl x509 -pubkey` gave the same SPKI); here, that core's DER walk
// finds the key in real v1 and v3 certificates. Hand-built DER vectors: core's `der.test.ts`.

import { describe, expect, test } from 'bun:test';
import { x509Spki } from '@ultimat3/core';
import { snsSigner } from './delivery-event-fixture';
import { pemCertificateDer, pemCertificateSpki } from './x509-spki';

describe('pemCertificateSpki', () => {
  test('finds the same key in an X.509 v3 and a v1 certificate, and Web Crypto imports it', async () => {
    const signer = await snsSigner();
    const v3 = pemCertificateSpki(signer.certificatePem);
    const v1 = pemCertificateSpki(signer.v1CertificatePem);
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
      expect(x509Spki(der.slice(0, length))).toBeUndefined();
    }
  });

  test('a PEM with no certificate block has no key', () => {
    expect(
      pemCertificateSpki('-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'),
    ).toBeUndefined();
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
