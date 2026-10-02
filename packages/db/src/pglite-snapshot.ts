// Single responsibility: the cache that turns an in-memory embedded boot from an `initdb` into a
// restore — a post-`initdb` data-directory tarball, keyed on what produced it, kept in a file the
// caller names and in this process's memory. Never trusted: a file is read only through its own
// checksum, and anything that does not verify is deleted and rebuilt.

// why: Bun has no rename and no recursive remove; the write is a temp name then an atomic rename.
import { rename, rm } from 'node:fs/promises';
// why: Bun ships no path joiner.
import { dirname, join } from 'node:path';
import { PGLITE_PACKAGE } from './pglite-package';

/** Bumped when the file layout below changes, so an old file is a miss rather than a misread. */
const SNAPSHOT_FORMAT = 1;
const MAGIC = `x-pglite-snapshot:${SNAPSHOT_FORMAT}:`;
/** `MAGIC`, 64 hex characters, a newline — then the tarball. */
const HEADER_BYTES = MAGIC.length + 64 + 1;

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/**
 * The installed PGlite's version, read off its own `package.json` — the package exports no
 * version and no `./package.json`, so the entry point is resolved and its manifest read beside
 * it. `undefined` when either step fails, which a caller reads as "do not cache": a snapshot that
 * cannot name what produced it must not outlive an upgrade.
 */
export async function pgliteVersion(
  resolve: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
): Promise<string | undefined> {
  try {
    const entry = Bun.fileURLToPath(resolve(PGLITE_PACKAGE));
    const manifest: unknown = await Bun.file(join(dirname(entry), '..', 'package.json')).json();
    const version = (manifest as { readonly version?: unknown } | null)?.version;
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a snapshot is a snapshot OF: the PGlite build, and this file's own layout. NOT the linked
 * extensions — `initdb` never sees them. An extension is files PGlite puts beside the data
 * directory at boot, so one snapshot serves every extension set, and an app that adds `citext`
 * does not pay a second `initdb` (`schema-dump.test.ts` restores a plain snapshot with one
 * linked and creates it).
 */
export const snapshotKey = (version: string): string => `${version}-f${SNAPSHOT_FORMAT}`;

export const snapshotFile = (dir: string, key: string): string =>
  join(dir, `pglite-${key}.snapshot`);

/** One snapshot per key for the life of the process: the second scratch boot never touches disk. */
const memo = new Map<string, Blob>();

export const rememberSnapshot = (key: string, blob: Blob): void => {
  memo.set(key, blob);
};

export const forgetSnapshot = (key: string): void => {
  memo.delete(key);
};

/**
 * The tarball, or `undefined` — for a file that is absent, short, mislabelled or whose bytes do
 * not hash to what its header says. A file that fails any of those is DELETED: it will never
 * verify, and leaving it costs every later boot the same read.
 */
export async function readSnapshot(file: string, key: string): Promise<Blob | undefined> {
  const held = memo.get(key);
  if (held !== undefined) return held;
  const onDisk = Bun.file(file);
  if (!(await onDisk.exists())) return undefined;
  const bytes = new Uint8Array(await onDisk.arrayBuffer());
  const header = new TextDecoder().decode(bytes.subarray(0, HEADER_BYTES));
  const body = bytes.subarray(HEADER_BYTES);
  const sound =
    header.startsWith(MAGIC) &&
    header.endsWith('\n') &&
    body.length > 0 &&
    header.slice(MAGIC.length, -1) === sha256(body);
  if (!sound) {
    await discardSnapshot(file, key);
    return undefined;
  }
  const blob = new Blob([body]);
  memo.set(key, blob);
  return blob;
}

/**
 * Written under a name no other process shares, then renamed over the target. A rename within one
 * directory is atomic, so a reader sees the old file or the new one and never half of either, and
 * two writers racing each leave a whole file — the last one wins, and both are correct.
 *
 * Best effort: a cache that cannot be written (a read-only checkout, a full disk) costs the next
 * boot an `initdb`, which is what it cost before there was a cache.
 */
export async function writeSnapshot(file: string, key: string, blob: Blob): Promise<void> {
  memo.set(key, blob);
  const body = new Uint8Array(await blob.arrayBuffer());
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, new Blob([`${MAGIC}${sha256(body)}\n`, body]), { createPath: true });
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function discardSnapshot(file: string, key: string): Promise<void> {
  memo.delete(key);
  await rm(file, { force: true }).catch(() => undefined);
}
