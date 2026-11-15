// `x dev --tls`'s certificate: a self-signed ECDSA P-256 X.509 built from WebCrypto alone, and
// the names a bind needs it to carry. Cached on disk by `dev-tls-cache.ts`.

import { classifyAddress } from '@ultimat3/core';
import {
  bitString,
  bool,
  ecdsaSignature,
  explicit,
  integer,
  octets,
  oid,
  pem,
  sequence,
  set,
  time,
  tlv,
  utf8,
} from './dev-tls-der';

export const DAY_MS = 86_400_000;
/** Short on purpose: a local certificate is regenerated for free, and browsers cap leaf lifetimes. */
export const DEV_CERT_DAYS = 90;

const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));
const SUBJECT = sequence(set(sequence(oid('2.5.4.3'), utf8('x dev local certificate'))));

export interface CertificatePair {
  readonly cert: string;
  readonly key: string;
}

/** Sixteen hex groups → bytes; `URL` first, so every spelling (`::ffff:1.2.3.4` too) is canonical. */
function v6Bytes(address: string): Uint8Array {
  const canonical = (URL.parse(`http://[${address.split('%')[0]}]`)?.hostname ?? '[::]').slice(
    1,
    -1,
  );
  const [head = '', tail] = canonical.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

/** `iPAddress [7]` for a literal, `dNSName [2]` for anything else — both IMPLICIT, primitive. */
function generalName(name: string): Uint8Array {
  if (classifyAddress(name) === undefined) return tlv(0x82, new TextEncoder().encode(name));
  const bytes = name.includes(':') ? v6Bytes(name) : Uint8Array.from(name.split('.').map(Number));
  return tlv(0x87, bytes);
}

const extension = (id: string, critical: boolean, value: Uint8Array): Uint8Array =>
  sequence(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function serialNumber(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) | 0x01; // positive and never a leading zero (RFC 5280 §4.1.2.2)
  return bytes;
}

/** A fresh pair carrying `names` in its subjectAltName — the only field a client matches on. */
export async function selfSignedCertificate(input: {
  readonly names: readonly string[];
  readonly now: Date;
}): Promise<CertificatePair> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const tbs = sequence(
    explicit(0, integer(Uint8Array.of(2))), // v3
    integer(serialNumber()),
    ECDSA_SHA256,
    SUBJECT,
    sequence(
      time(new Date(input.now.getTime() - 3_600_000)),
      time(new Date(input.now.getTime() + DEV_CERT_DAYS * DAY_MS)),
    ),
    SUBJECT,
    spki,
    explicit(
      3,
      sequence(
        extension('2.5.29.19', true, sequence()), // basicConstraints: not a CA
        extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))), // serverAuth
        extension('2.5.29.17', false, sequence(...input.names.map(generalName))),
      ),
    ),
  );
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      new Uint8Array(tbs),
    ),
  );
  const der = sequence(tbs, ECDSA_SHA256, bitString(ecdsaSignature(raw)));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { cert: pem('CERTIFICATE', der), key: pem('PRIVATE KEY', pkcs8) };
}

/**
 * The names a certificate for a bind on `hostname` carries: loopback in every spelling, plus the
 * address itself when it is a specific one a client on another machine would dial.
 */
export function certificateNames(hostname: string): readonly string[] {
  const base = ['localhost', '127.0.0.1', '::1'];
  // A wildcard is dialled as loopback; any other literal — `127.0.0.2` included — is the url printed.
  const kind = classifyAddress(hostname);
  const dialled = kind !== undefined && kind !== 'unspecified' && !base.includes(hostname);
  return dialled ? [...base, hostname] : base;
}
