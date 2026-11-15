// Single responsibility: the cache that turns an in-memory embedded boot from an `initdb` into a
// restore — a post-`initdb` data-directory tarball, keyed on what produced it, kept in a file the
// caller names and in this process's memory. Never trusted: a file is read only through its own
// checksum, and anything that does not verify is deleted and rebuilt.

// why: Bun has no rename and no recursive remove; the write is a temp name then an atomic rename.
import { rename, rm } from 'node:fs/promises';
// why: Bun ships no path joiner.
import { basename, dirname, join } from 'node:path';
import { evictCacheFiles } from '@ultimat3/core';
import type { PgliteDriver } from './pglite';
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

/** A snapshot file of any key, and the temp name `writeSnapshot` writes it under first. */
const isSnapshot = (name: string): boolean => /^pglite-.+\.snapshot$/.test(name);
const isSnapshotTemp = (name: string): boolean => /^pglite-.+\.snapshot\..+\.tmp$/.test(name);

/** One snapshot per key for the life of the process: the second scratch boot never touches disk. */
const memo = new Map<string, Blob>();

export const rememberSnapshot = (key: string, blob: Blob): void => {
  memo.set(key, blob);
};

export const forgetSnapshot = (key: string): void => {
  memo.delete(key);
};

/**
 * The tarball, or `undefined` — for a file that is absent, unreadable, short, mislabelled or whose
 * bytes do not hash to what its header says. A file that fails any of those is DELETED: it will never
 * verify, and leaving it costs every later boot the same read.
 */
export async function readSnapshot(file: string, key: string): Promise<Blob | undefined> {
  const held = memo.get(key);
  if (held !== undefined) return held;
  const onDisk = Bun.file(file);
  if (!(await onDisk.exists())) return undefined;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await onDisk.arrayBuffer());
  } catch {
    // `exists()` and the read are two calls: a racing `discardSnapshot` (ENOENT) or a file this
    // user cannot read (EACCES) lands between them. A cache that cannot be read is a miss, never
    // a failed boot — and it is not deleted, since this process could not read it to judge it.
    return undefined;
  }
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
export async function writeSnapshot(
  file: string,
  key: string,
  blob: Blob,
  keepPrevious = 1,
): Promise<void> {
  memo.set(key, blob);
  const body = new Uint8Array(await blob.arrayBuffer());
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, new Blob([`${MAGIC}${sha256(body)}\n`, body]), { createPath: true });
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    return;
  }
  // One file per PGlite version, and nothing else ever removes an old version's (#738): keep this
  // one and the newest previous one, which a second checkout on the older PGlite may be reading.
  // A caller-keyed cache (`dataSnapshot`, below) keeps its own count in a directory of its own.
  // A reader loads the whole file in one read and takes a missing one as a miss, so no lock.
  await evictCacheFiles({
    dir: dirname(file),
    current: basename(file),
    matches: isSnapshot,
    temporary: isSnapshotTemp,
    keepPrevious,
  });
}

export async function discardSnapshot(file: string, key: string): Promise<void> {
  memo.delete(key);
  await rm(file, { force: true }).catch(() => undefined);
}

// A CALLER-keyed snapshot of an in-memory database's whole data directory — a scratch database the
// caller migrated, restored on the next boot naming the same key. In this file, not its own: a
// lazy `import()` of a second module made Bun wrap every shared module in `__esm` init stubs, +740 B
// in the browser rpc chunk that reaches this barrel (`client-bundle.test.ts`).

/** `PgliteOptions.dataSnapshot`: where the caller's snapshots live, and which one this boot is. */
export interface PgliteDataSnapshot {
  /** A directory of this cache's own: its files are evicted newest-`keep` first. */
  readonly dir: string;
  /** What produced the state, hashed by the caller (schema, migrations). Never a TTL. */
  readonly key: string;
  /** Snapshots besides the one just written to keep. Default 2. */
  readonly keep?: number | undefined;
}

/** The file and memo key of `snapshot` under the installed PGlite `version`. */
export function dataSnapshotAt(
  snapshot: PgliteDataSnapshot,
  version: string,
): { readonly file: string; readonly key: string } {
  const key = `${snapshotKey(version)}-${snapshot.key}`;
  return { file: snapshotFile(snapshot.dir, key), key };
}

/**
 * Where `snapshot` lives, or `undefined`: none asked, a boot on disk (a directory is its own
 * snapshot), or a PGlite that cannot name its version — a cache that must not outlive an upgrade.
 */
export async function dataSnapshotFor(
  snapshot: PgliteDataSnapshot | undefined,
  inMemory: boolean,
  version: () => Promise<string | undefined>,
): Promise<{ readonly file: string; readonly key: string } | undefined> {
  if (snapshot === undefined || !inMemory) return undefined;
  const named = await version();
  return named === undefined ? undefined : dataSnapshotAt(snapshot, named);
}

/** The drivers a boot restored from a caller's snapshot: they hold its state already. */
const restored = new WeakSet<PgliteDriver>();

export const markRestored = (driver: PgliteDriver): void => {
  restored.add(driver);
};

export const wasRestored = (driver: PgliteDriver): boolean => restored.has(driver);

/**
 * The driver's data directory, written under `at` — unless it was restored from that very file, or
 * the driver cannot dump. Best effort, as the post-`initdb` cache is: a write that fails costs the
 * next boot a migration, which is what it cost before.
 */
export async function saveDataSnapshot(
  driver: PgliteDriver,
  at: { readonly file: string; readonly key: string } | undefined,
  keep: number | undefined,
): Promise<boolean> {
  if (at === undefined || wasRestored(driver) || driver.dumpDataDir === undefined) return false;
  try {
    await writeSnapshot(at.file, at.key, await driver.dumpDataDir('none'), keep ?? 2);
    return true;
  } catch {
    return false;
  }
}
