// Single responsibility: an IdP's X.509 signing certificate (base64 DER, as metadata carries it)
// → the RSA public key Web Crypto verifies with, its `subjectPublicKeyInfo` lifted by core's
// `x509Spki` (Web Crypto takes no certificate).
// Only the key is trusted: the certificate's dates and issuer are the metadata's business.

import { x509Spki } from '@ultimat3/core';

/** NIST SP 800-131A: an RSA key under 2048 bits signs nothing an SP should believe. */
export const MIN_SAML_RSA_BITS = 2048;

/** Strict base64 with the white space metadata wraps it in; `undefined` for anything else. */
export function base64Bytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  const compact = text.replace(/[ \t\r\n]+/g, '');
  if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return undefined;
  }
  const binary = atob(compact);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The certificate's `subjectPublicKeyInfo` (core's one DER walk), or `undefined`. */
export function certificateSpki(base64Der: string): Uint8Array<ArrayBuffer> | undefined {
  const der = base64Bytes(base64Der);
  return der === undefined ? undefined : x509Spki(der);
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
