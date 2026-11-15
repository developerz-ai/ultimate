// `x dev --tls`'s certificate: a self-signed ECDSA P-256 X.509 built from WebCrypto alone and
// cached under the app's state directory (`.x/tls/`, gitignored, never committed). Regenerated
// when the names it must carry change or its end is near; otherwise the same bytes every boot, so
// a browser exception or a `curl --cacert` the developer made once keeps working.

// why: Bun.write takes no file mode — the key is CREATED 0600 in a 0700 directory, never chmod'ed after.
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
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

const DAY_MS = 86_400_000;
/** Short on purpose: a local certificate is regenerated for free, and browsers cap leaf lifetimes. */
export const DEV_CERT_DAYS = 90;
/** Inside this window of its end, a cached certificate is replaced rather than served. */
const RENEW_WITHIN_MS = 7 * DAY_MS;

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
  const kind = classifyAddress(hostname);
  const specific = kind !== undefined && kind !== 'unspecified' && kind !== 'loopback';
  return specific ? [...base, hostname] : base;
}

export interface DevCertificate extends CertificatePair {
  /** Where the certificate sits, for `curl --cacert` or a browser's trust store. */
  readonly certPath: string;
}

interface CachedMeta {
  readonly names: readonly string[];
  readonly notAfter: number;
}

async function readMeta(path: string): Promise<CachedMeta | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const parsed: unknown = await file.json().catch(() => undefined);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { names, notAfter } = parsed as Record<string, unknown>;
  if (!Array.isArray(names) || typeof notAfter !== 'number') return undefined;
  return { names: names.filter((name): name is string => typeof name === 'string'), notAfter };
}

/**
 * The cached key exists and no one but its owner can read it. A wider mode — a copy, an editor's
 * save under umask 0002 — is not served: the pair is regenerated. Windows has no POSIX mode bits
 * to read, so there the file's existence is the whole check.
 */
async function keyIsPrivate(path: string): Promise<boolean> {
  const found = await stat(path).catch(() => undefined);
  if (found === undefined || !found.isFile()) return false;
  return process.platform === 'win32' || (found.mode & 0o077) === 0;
}

/** The cached pair when it carries exactly `names` and is not near its end; else a new one, written. */
export async function devCertificate(input: {
  readonly stateDir: string;
  readonly names: readonly string[];
  readonly now: Date;
}): Promise<DevCertificate> {
  const dir = join(input.stateDir, 'tls');
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  const metaPath = join(dir, 'meta.json');
  const names = [...new Set(input.names)].sort();
  const meta = await readMeta(metaPath);
  const fresh =
    meta !== undefined &&
    meta.names.join(',') === names.join(',') &&
    meta.notAfter - input.now.getTime() > RENEW_WITHIN_MS;
  if (fresh && (await Bun.file(certPath).exists()) && (await keyIsPrivate(keyPath))) {
    return { cert: await Bun.file(certPath).text(), key: await Bun.file(keyPath).text(), certPath };
  }
  const pair = await selfSignedCertificate({ names, now: input.now });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700); // an existing `.x/tls` keeps whatever mode it was made with otherwise
  // Removed, then created exclusively at 0600: a write over an existing 0644 file keeps 0644, and
  // a chmod after the write leaves a window in which the key is readable by everyone.
  await rm(keyPath, { force: true });
  await writeFile(keyPath, pair.key, { mode: 0o600, flag: 'wx' });
  await Bun.write(certPath, pair.cert);
  const notAfter = input.now.getTime() + DEV_CERT_DAYS * DAY_MS;
  await Bun.write(metaPath, JSON.stringify({ names, notAfter }));
  return { ...pair, certPath };
}
