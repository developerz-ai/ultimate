// One island group's built output, kept under `.x/cache/islands/` and reused while everything the
// build read still says the same: each file's bytes (the bundler's inputs and every Sass partial a
// sheet `@use`s), each directory listing an import was resolved in, and the shared environment in
// the key (`island-cache-inputs.ts`). It reuses BYTES, never a layout.
//
// The prebuilt store's rule (`island-store.ts`: record what went in, rehash it before serving) at
// the grain a build runs at — one group — so a restart rebuilds only the groups an edit reached.
// Measured on the 5,124-file bench app (159 islands, 157 groups), As of 2026-11-10: islands
// 14.6–21 s built (load-dependent), 0.42 s reused, 0.8 s with one island edited — 10,241,659 B
// either way.

// why: Bun ships no rename, mkdir, unlink, directory listing or utimes. An entry is written beside
// itself and renamed into place, so a reader in another process never parses half a file.
import { mkdir, readdir, rename, unlink, utimes } from 'node:fs/promises';
// why: Bun ships no path API.
import { dirname, join } from 'node:path';
import { frameworkVersion } from '@ultimat3/core';
import { contentHash } from '@ultimat3/render/server';
import type { IslandChunk, SharedChunk } from './island-bundle';
import type { InputDigester } from './island-cache-inputs';
import { listingDigester, resolutionDirs } from './island-cache-inputs';
import { stableChunk } from './island-identity';
import { isStylesheet, registerIslandStylesheet } from './island-styles';
import { hasPathSegment } from './path-segments';

/** App-root-relative: `.x/` is the app's own scratch tree, kept across `x dev` restarts. */
export const ISLAND_CACHE_DIR = '.x/cache/islands';

/** Bumped when an entry's shape or meaning changes: an older entry is a miss, never a misread. */
// 3: URLs name the bytes (#1075); a 2 entry holds source-addressed URLs a 3 build never mints.
const FORMAT = 3;

/** An entry or a partial nobody read or wrote for this long is swept. */
const SWEEP_AFTER_MS = 14 * 86_400_000;

/**
 * Coarse mtimes (1–2 s on some filesystems) and a clock stepped back read an edit made during the
 * build as one made before it: anything modified this close to the start is treated as raced.
 */
const MTIME_SLACK_MS = 2_000;

/** What one `buildAll` answers, plus what it read — the half a cache entry is verified by. */
export interface GroupOutput {
  readonly chunks: readonly IslandChunk[];
  readonly shared: readonly SharedChunk[];
  /** Every file the build read, absolute: the bundler's inputs and each sheet's Sass partials. */
  readonly inputs: readonly string[];
  /** Every stylesheet the build registered, absolute — registered again on a hit. */
  readonly stylesheets: readonly string[];
}

interface Stamp {
  readonly path: string;
  readonly digest: string;
}

type Stored<T> = T & { readonly codeHash: string };

interface Entry {
  readonly format: number;
  readonly key: string;
  readonly chunks: readonly Stored<IslandChunk>[];
  readonly shared: readonly Stored<SharedChunk>[];
  readonly inputs: readonly Stamp[];
  /** Directory listings, digested: a file added where a resolver looks is a miss. */
  readonly dirs: readonly Stamp[];
  readonly stylesheets: readonly string[];
}

/**
 * Everything a group's output depends on besides what it read: the group, how it is split, the
 * framework and Bun that build it, the shared environment (`environmentDigest`), and the realtime
 * answer the app gives (`null` for a group no island of which reaches realtime).
 */
export function groupKey(parts: {
  readonly group: readonly string[];
  readonly splitting: boolean;
  readonly environment: string;
  readonly persists: boolean | undefined;
}): string {
  return contentHash(
    JSON.stringify([
      FORMAT,
      frameworkVersion(),
      Bun.version,
      parts.environment,
      parts.group,
      parts.splitting,
      parts.persists ?? null,
    ]),
  );
}

const entryPath = (root: string, key: string): string =>
  join(root, ISLAND_CACHE_DIR, `${key}.json`);

const isStamp = (value: unknown): value is Stamp => {
  const one = value as Record<string, unknown> | null;
  return typeof one?.['path'] === 'string' && typeof one['digest'] === 'string';
};

const hashed = (value: unknown): boolean => {
  const one = value as Record<string, unknown> | null;
  return typeof one?.['code'] === 'string' && one['codeHash'] === contentHash(one['code']);
};

const strings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((one) => typeof one === 'string');

const count = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

/** Every field a served chunk is read by: a hit hands it to the resolver, the store and the route. */
const isChunk = (value: unknown): boolean => {
  const one = value as Record<string, unknown>;
  const kind = one['realtime'];
  return (
    hashed(value) &&
    typeof one['file'] === 'string' &&
    typeof one['moduleId'] === 'string' &&
    typeof one['url'] === 'string' &&
    count(one['bytes']) &&
    strings(one['imports']) &&
    (one['sources'] === undefined || strings(one['sources'])) &&
    (kind === undefined || kind === 'restores' || kind === 'follows')
  );
};

const isShared = (value: unknown): boolean => {
  const one = value as Record<string, unknown>;
  return (
    hashed(value) &&
    typeof one['url'] === 'string' &&
    count(one['bytes']) &&
    strings(one['importers']) &&
    (one['sources'] === undefined || strings(one['sources']))
  );
};

/**
 * A file on disk is input, so the entry proves what it serves before any of it is: inputs to
 * rehash (none is a refusal — it would verify trivially), every chunk whole (each field a hit
 * reads, its code matching its recorded hash), and every stylesheet one of the recorded inputs or an installed package's (`node_modules`,
 * versioned by the lockfile in the key) — a sheet is compiled into served CSS.
 */
function parseEntry(value: unknown, key: string): Entry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const { format, chunks, shared, inputs, dirs, stylesheets } = entry;
  if (format !== FORMAT || entry['key'] !== key) return undefined;
  if (![chunks, shared, inputs, dirs, stylesheets].every(Array.isArray)) return undefined;
  const stamps = inputs as readonly unknown[];
  if (stamps.length === 0 || !stamps.every(isStamp)) return undefined;
  if (!(dirs as readonly unknown[]).every(isStamp)) return undefined;
  if (!(chunks as unknown[]).every(isChunk) || !(shared as unknown[]).every(isShared)) {
    return undefined;
  }
  const recorded = new Set((stamps as readonly Stamp[]).map((stamp) => stamp.path));
  const sheetOk = (sheet: unknown): boolean =>
    typeof sheet === 'string' &&
    isStylesheet(sheet) &&
    (recorded.has(sheet) || hasPathSegment(sheet, 'node_modules'));
  return (stylesheets as readonly unknown[]).every(sheetOk) ? (value as Entry) : undefined;
}

/** `/islands/<id>-<identity>.js`, `chunk-<identity>.js`, `page-runtime.<identity>.js`. */
const identityOf = (url: string): string => /[-.]([0-9a-z]+)\.js$/.exec(url)?.[1] ?? url;

const unchanged = async (stamps: readonly Stamp[], digestOf: InputDigester): Promise<boolean> => {
  const digests = await Promise.all(stamps.map((stamp) => digestOf(stamp.path)));
  return stamps.every((stamp, index) => digests[index] === stamp.digest);
};

/**
 * The group's output as it was built, when every input and listing still hashes the same;
 * `undefined` otherwise. A hit touches the entry (the sweep keeps what is read) and seeds
 * `stableChunk`, so a later in-process build of the same graph serves these bytes at this URL.
 */
export async function readGroup(
  root: string,
  key: string,
  digestOf: InputDigester,
  listingOf: InputDigester = listingDigester(),
): Promise<
  { readonly chunks: readonly IslandChunk[]; readonly shared: readonly SharedChunk[] } | undefined
> {
  const path = entryPath(root, key);
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const entry = parseEntry(await file.json().catch(() => undefined), key);
  if (entry === undefined) return undefined;
  if (!(await unchanged(entry.inputs, digestOf))) return undefined;
  if (!(await unchanged(entry.dirs, listingOf))) return undefined;
  for (const sheet of entry.stylesheets) {
    const source = Bun.file(sheet);
    if (!(await source.exists())) return undefined;
    registerIslandStylesheet(sheet, await source.text());
  }
  const now = new Date();
  await utimes(path, now, now).catch(() => undefined);
  const strip = <T>({ codeHash: _, ...rest }: Stored<T>): T => rest as T;
  const chunks = entry.chunks.map(strip<IslandChunk>).map((chunk) => ({
    ...chunk,
    ...stableChunk(chunk.file, identityOf(chunk.url), chunk.code),
  }));
  const shared = entry.shared.map(strip<SharedChunk>).map((one) => ({
    ...one,
    ...stableChunk(one.url, identityOf(one.url), one.code),
  }));
  return { chunks, shared };
}

/**
 * Records the group's output and what it read. The digests are `digestOf`'s and `listingOf`'s —
 * memoised, so a file or directory the pre-build `readGroup` already hashed is stamped as it was
 * BEFORE the build, and an edit during it is a miss next time whatever its mtime says. One hashed
 * only now is guarded by its mtime, with `MTIME_SLACK_MS` for coarse clocks: modified near or
 * after the start — a directory included, which an added or removed name moves — no entry.
 */
export async function writeGroup(
  root: string,
  key: string,
  output: GroupOutput,
  startedAt: number,
  digestOf: InputDigester,
  listingOf: InputDigester = listingDigester(),
): Promise<void> {
  // A directory's mtime moves when a name is added or removed in it: `util.ts` landing beside
  // `util/` mid-build changes no input's bytes, only what `./util` would now resolve to.
  const listed = resolutionDirs(output.inputs);
  const raced = [...output.inputs, ...listed].some(
    (path) => Bun.file(path).lastModified > startedAt - MTIME_SLACK_MS,
  );
  if (raced || output.inputs.length === 0) return;
  const stamp = async (paths: readonly string[], of: InputDigester) => {
    const digests = await Promise.all(paths.map((path) => of(path)));
    const stamps = paths.map((path, index) => ({ path, digest: digests[index] }));
    return stamps.every((one): one is Stamp => one.digest !== undefined) ? stamps : undefined;
  };
  const inputs = await stamp(output.inputs, digestOf);
  const dirs = await stamp(listed, listingOf);
  if (inputs === undefined || dirs === undefined) return;
  const withHash = <T extends { readonly code: string }>(one: T): Stored<T> => ({
    ...one,
    codeHash: contentHash(one.code),
  });
  const entry: Entry = {
    format: FORMAT,
    key,
    chunks: output.chunks.map(withHash),
    shared: output.shared.map(withHash),
    inputs,
    dirs,
    stylesheets: output.stylesheets,
  };
  const path = entryPath(root, key);
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    await Bun.write(partial, JSON.stringify(entry));
    await rename(partial, path);
  } catch (error) {
    // A failed rename (EPERM on Windows while a reader holds the entry) left the partial: remove it
    // before the caller hears the failure, or every such write leaves a file the size of a group.
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

/**
 * Removes every entry and partial in the cache not touched for `SWEEP_AFTER_MS` before `now`: a
 * group whose key moved (a renamed island, a new framework version) is never read again. A hit
 * touches its entry, so only the abandoned go.
 */
export async function sweepGroupCache(root: string, now: number): Promise<void> {
  const dir = join(root, ISLAND_CACHE_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const file = Bun.file(join(dir, name));
    if (file.lastModified < now - SWEEP_AFTER_MS) await unlink(join(dir, name)).catch(() => {});
  }
}

const swept = new Set<string>();

/** `sweepGroupCache` at most once per root per process: a sweep is a listing, not per build. */
export function sweepOnce(root: string): Promise<void> {
  if (swept.has(root)) return Promise.resolve();
  swept.add(root);
  return sweepGroupCache(root, performance.timeOrigin + performance.now());
}
