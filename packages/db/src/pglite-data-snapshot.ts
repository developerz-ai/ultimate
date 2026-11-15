// Single responsibility: a CALLER-keyed snapshot of an in-memory embedded database's whole data
// directory — a scratch database the caller migrated, restored on the next boot that names the same
// key instead of being migrated again. The key is the caller's (what produced the state) plus the
// PGlite build, so an upgrade or a new migration is a miss; the file is `pglite-snapshot.ts`'s.

import type { PgliteDriver } from './pglite';
import { snapshotFile, snapshotKey, writeSnapshot } from './pglite-snapshot';

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
