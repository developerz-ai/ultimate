// The files on disk an island chunk was built from, and whether they still hold those bytes. The
// prebuilt store (`island-store.ts`) verified only its own chunk bytes, so a source edited after
// `x build --target prebuilt` still verified and a boot served the chunk built from the old one.

// why: Bun ships no path join/resolve/relative primitive.
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { contentHash } from '@ultimat3/render/server';
import { hasPathSegment } from './path-segments';

/**
 * App-root-relative POSIX paths of the files an output was built from — its source map's
 * `sources`, outside `node_modules` and inside the app root.
 */
export type SourcePaths = readonly string[];

/**
 * A path the store may record and a boot may read: app-root-relative, normalized, inside the
 * root, outside `node_modules`. The writer filters on it and the reader REFUSES on it — the index is
 * a file on disk, and a path read at every boot must never be `../../etc/hostname` or `/dev/zero`.
 */
export function isRecordableSource(path: string): boolean {
  return (
    path !== '' &&
    posix.normalize(path) === path &&
    !path.startsWith('..') &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !hasPathSegment(path, 'node_modules')
  );
}

/** One recorded source: its path and the content digest of its bytes when the store was written. */
export interface SourceStamp {
  readonly path: string;
  readonly digest: string;
}

/**
 * A source map's `sources` that are files in the app. A virtual module (the realtime wrapper) has
 * no file; `node_modules` changes only with an install, and hashing it would make every pod boot
 * pay for the dependency tree.
 */
export async function sourcesOnDisk(root: string, map: unknown): Promise<SourcePaths> {
  const listed: unknown =
    typeof map === 'object' && map !== null ? (map as Record<string, unknown>)['sources'] : [];
  // Bun 1.4.2 writes each source relative to the BUILDING process's cwd, not to the map or to the
  // build's `root` (measured: a build run from the repo root over a /tmp app names
  // `../../tmp/…/plain.island.tsx`), so that is what they are resolved against.
  const cwd = process.cwd();
  const paths = (Array.isArray(listed) ? listed : [])
    .filter((one): one is string => typeof one === 'string')
    .map((one) => relative(root, resolve(cwd, one)).split(sep).join('/'))
    .filter(isRecordableSource);
  const present = await Promise.all(paths.map((one) => Bun.file(join(root, one)).exists()));
  return [...new Set(paths.filter((_, index) => present[index]))].sort();
}

/** Each path with the content digest of its bytes now — `undefined` for a file that is gone. */
export type SourceDigester = (path: string) => Promise<string | undefined>;

/**
 * A digester that reads each file once, however many chunks name it: a module shared by every
 * island is one read per boot, not one per island.
 */
export function sourceDigester(root: string): SourceDigester {
  const seen = new Map<string, Promise<string | undefined>>();
  return (path) => {
    let digested = seen.get(path);
    if (digested === undefined) {
      const file = Bun.file(join(root, path));
      digested = file
        .exists()
        .then(async (exists) => (exists ? contentHash(await file.text()) : undefined));
      seen.set(path, digested);
    }
    return digested;
  };
}

/** What the store records for one chunk's sources. */
export async function stampSources(
  paths: SourcePaths,
  digestOf: SourceDigester,
): Promise<readonly SourceStamp[]> {
  const stamps: SourceStamp[] = [];
  for (const path of paths) {
    const now = await digestOf(path);
    if (now !== undefined) stamps.push({ path, digest: now });
  }
  return stamps;
}

/**
 * The first recorded source that is gone or whose content digest moved, else `undefined`. A plain
 * comparison: a digest of a source file the app commits is no secret, and nothing here is timed.
 */
export async function changedSource(
  stamps: readonly SourceStamp[],
  digestOf: SourceDigester,
): Promise<string | undefined> {
  for (const stamp of stamps) {
    if ((await digestOf(stamp.path)) !== stamp.digest) return stamp.path;
  }
  return undefined;
}
