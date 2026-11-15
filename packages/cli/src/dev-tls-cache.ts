// `x dev --tls`'s certificate on disk: `.x/tls/` (0700; gitignored, never committed), the key
// created 0600, and `meta.json` written last as the one thing that vouches for the pair. Reused
// while the names match, its end is not near and the cert and key belong together; else regenerated.

// why: WebCrypto parses no X.509, and the cached cert must be proven to match the cached key.
import { createPrivateKey, X509Certificate } from 'node:crypto';
// why: Bun.write takes no file mode — the key is CREATED 0600 in a 0700 directory, never chmod'ed after.
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import type { CertificatePair } from './dev-tls';
import { DAY_MS, DEV_CERT_DAYS, selfSignedCertificate } from './dev-tls';

/** Inside this window of its end, a cached certificate is replaced rather than served. */
const RENEW_WITHIN_MS = 7 * DAY_MS;

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

/**
 * The cached cert and key when they BELONG together — a key written by a regeneration that never
 * reached its cert would otherwise be served beside the old cert, and every handshake fails.
 */
async function cachedPair(certPath: string, keyPath: string): Promise<CertificatePair | undefined> {
  const cert = await Bun.file(certPath)
    .text()
    .catch(() => undefined);
  const key = await Bun.file(keyPath)
    .text()
    .catch(() => undefined);
  if (cert === undefined || key === undefined) return undefined;
  try {
    return new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))
      ? { cert, key }
      : undefined;
  } catch {
    return undefined; // unparseable is as stale as mismatched: regenerated, never served
  }
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
  if (fresh && (await keyIsPrivate(keyPath))) {
    const cached = await cachedPair(certPath, keyPath);
    if (cached !== undefined) return { ...cached, certPath };
  }
  const pair = await selfSignedCertificate({ names, now: input.now });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700); // an existing `.x/tls` keeps whatever mode it was made with otherwise
  // meta.json FIRST: it is what vouches for the pair, so a run killed (or failing) between the
  // key and the cert leaves nothing vouching for the torn pair, and the next boot regenerates.
  await rm(metaPath, { force: true });
  // Removed, then created exclusively at 0600: a write over an existing 0644 file keeps 0644, and
  // a chmod after the write leaves a window in which the key is readable by everyone.
  await rm(keyPath, { force: true });
  await writeFile(keyPath, pair.key, { mode: 0o600, flag: 'wx' });
  await Bun.write(certPath, pair.cert);
  const notAfter = input.now.getTime() + DEV_CERT_DAYS * DAY_MS;
  await Bun.write(metaPath, JSON.stringify({ names, notAfter }));
  return { ...pair, certPath };
}
