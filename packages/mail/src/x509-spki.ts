// Single responsibility: the public key out of a PEM X.509 certificate, as the SubjectPublicKeyInfo
// bytes Web Crypto imports (`importKey('spki', …)`). The PEM armour is SNS's and read here; the DER
// walk is core's `x509Spki`. Malformed input is `undefined`, never a throw.

import { x509Spki } from '@ultimat3/core';

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

/** The `subjectPublicKeyInfo` of the first `CERTIFICATE` block, or `undefined`. */
export function pemCertificateSpki(pem: string): Uint8Array<ArrayBuffer> | undefined {
  const der = pemCertificateDer(pem);
  return der === undefined ? undefined : x509Spki(der);
}
