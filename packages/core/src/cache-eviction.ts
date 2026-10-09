// Eviction for a content-keyed cache directory: each file is written once per key (a PGlite build,
// a migration state) and never read again once the key moves on. Nothing evicted them, so an app's
// `.x/test-db` reached 72 migrated templates, 4.2 GB (#738). The writer of a new key calls this.
//
// Safe without a lock, by what it keeps and by what a reader does: the CURRENT file is never
// touched, the newest previous one stays (a second checkout, or a run still on the old migrations,
// may be reading it), and every reader in the framework loads a cache file whole in one read and
// takes a missing one as a miss — so a delete racing a read costs a rebuild, never a failure.

// why: Bun has no readdir, stat or remove.
import { readdir, rm, stat } from 'node:fs/promises';
// why: Bun ships no path joiner.
import { join } from 'node:path';

/** A temp file younger than this may be a write in flight in another process; older is debris. */
export const CACHE_TEMP_GRACE_MS = 10 * 60 * 1000;

export interface CacheEvictionOptions {
  readonly dir: string;
  /** The file name just written or read — never removed. `undefined` keeps none by name. */
  readonly current: string | undefined;
  /** Which names in `dir` are entries of THIS cache. Anything else is never touched. */
  readonly matches: (name: string) => boolean;
  /** Entries besides `current` to keep, newest first. Default 1. */
  readonly keepPrevious?: number;
  /** Half-written temp names (`*.partial`, `*.tmp`): removed once older than the grace. */
  readonly temporary?: (name: string) => boolean;
  /** Name what would go and remove nothing. */
  readonly dryRun?: boolean;
  readonly now?: () => number;
}

/** Removes the evicted files and answers their paths. Best effort: a file already gone is fine. */
export async function evictCacheFiles(options: CacheEvictionOptions): Promise<readonly string[]> {
  let names: string[];
  try {
    names = await readdir(options.dir);
  } catch {
    return [];
  }
  const now = (options.now ?? Date.now)();
  const aged: { readonly path: string; readonly mtimeMs: number }[] = [];
  const debris: string[] = [];
  for (const name of names) {
    const entry = options.matches(name) && name !== options.current;
    const temp = !entry && options.temporary?.(name) === true;
    if (!entry && !temp) continue;
    const path = join(options.dir, name);
    let mtimeMs: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      mtimeMs = info.mtimeMs;
    } catch {
      continue;
    }
    if (entry) aged.push({ path, mtimeMs });
    else if (now - mtimeMs > CACHE_TEMP_GRACE_MS) debris.push(path);
  }
  aged.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = Math.max(0, options.keepPrevious ?? 1);
  const evicted = [...aged.slice(keep).map((file) => file.path), ...debris];
  if (options.dryRun !== true) {
    for (const path of evicted) await rm(path, { force: true }).catch(() => undefined);
  }
  return evicted;
}
