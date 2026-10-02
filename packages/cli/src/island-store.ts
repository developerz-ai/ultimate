// The island chunks a container serves, built ONCE inside the image build by
// `x build --target prebuilt` and read back at boot. Without it every web pod's boot ran
// `Bun.build` — Babel, the JSX transform, a minifier — for every island, on every start, and a
// chunk whose URL is a hash of its sources was rebuilt from sources that could not have changed.
//
// Load-and-VERIFY, never load-and-trust: a store written by another framework or Bun version, one
// that names a different set of islands than the app has, or a chunk whose bytes do not hash to
// what the index recorded is refused, and the boot builds instead — and says so.

import { join, relative, sep } from 'node:path'; // why: Bun ships no path-join primitive.
import { frameworkVersion } from '@ultimat3/core';
import { contentHash, loadStylesheet } from '@ultimat3/render/server';
import type { IslandBundle, IslandChunk, SharedChunk } from './island-bundle';
import { buildIslands, discoverIslands, islandBundle } from './island-bundle';
import { islandStylesheets } from './island-styles';
import { PREBUILT_ISLANDS_DIR } from './serve-prebuilt-paths';

/** App-root-relative, inside the image's prebuilt store (`serve-prebuilt-paths.ts` says why there). */
export const ISLAND_STORE_DIR = PREBUILT_ISLANDS_DIR;
const INDEX = 'index.json';

interface StoredChunk {
  readonly file: string;
  readonly moduleId: string;
  readonly url: string;
  readonly identity: string;
  /** The shared chunk URLs the entry loads, transitively (`IslandChunk.imports`). */
  readonly imports: readonly string[];
}

/** A shared chunk: no island of its own, verified by the same hash. */
interface StoredShared {
  readonly url: string;
  readonly identity: string;
  readonly importers: readonly string[];
}

interface StoreIndex {
  readonly framework: string;
  readonly bun: string;
  readonly chunks: readonly StoredChunk[];
  /** Absent in a store written before islands were split: read as none. */
  readonly shared: readonly StoredShared[];
  /**
   * The stylesheets the island build registered, app-relative and sorted. Registered again at boot
   * from the app's own sources, so a container serving these chunks joins the SAME surface
   * stylesheet a build would — without them an island-only sheet was missing from every pod that
   * read the store, and present on any that rebuilt.
   */
  readonly stylesheets: readonly string[];
}

const chunkFile = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

/** Writes every chunk and the index that verifies them. Answers the files written, app-relative. */
export async function writeIslandStore(
  root: string,
  bundle: IslandBundle,
): Promise<readonly string[]> {
  const dir = join(root, ISLAND_STORE_DIR);
  const chunks: StoredChunk[] = [];
  const written: string[] = [];
  for (const chunk of bundle.chunks) {
    await Bun.write(join(dir, chunkFile(chunk.url)), chunk.code);
    written.push(`${ISLAND_STORE_DIR}/${chunkFile(chunk.url)}`);
    chunks.push({
      file: chunk.file,
      moduleId: chunk.moduleId,
      url: chunk.url,
      identity: contentHash(chunk.code),
      imports: chunk.imports,
    });
  }
  const shared: StoredShared[] = [];
  for (const chunk of bundle.shared) {
    await Bun.write(join(dir, chunkFile(chunk.url)), chunk.code);
    written.push(`${ISLAND_STORE_DIR}/${chunkFile(chunk.url)}`);
    shared.push({ url: chunk.url, identity: contentHash(chunk.code), importers: chunk.importers });
  }
  const stylesheets = islandStylesheets()
    .map((path) => relative(root, path).split(sep).join('/'))
    .filter((path) => !path.startsWith('..'))
    .sort();
  const index: StoreIndex = {
    framework: frameworkVersion(),
    bun: Bun.version,
    chunks,
    shared,
    stylesheets,
  };
  await Bun.write(join(dir, INDEX), `${JSON.stringify(index, null, 2)}\n`);
  return [...written, `${ISLAND_STORE_DIR}/${INDEX}`];
}

const isString = (value: unknown): value is string => typeof value === 'string';

const stringsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter(isString) : [];

/** The index, narrowed field by field — a file on disk is input, never a trusted shape. */
function parseIndex(value: unknown): StoreIndex | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const chunks = record['chunks'];
  if (!isString(record['framework']) || !isString(record['bun']) || !Array.isArray(chunks)) {
    return undefined;
  }
  const parsed: StoredChunk[] = [];
  for (const entry of chunks) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const chunk = entry as Record<string, unknown>;
    const { file, moduleId, url, identity, imports } = chunk;
    if (!isString(file) || !isString(moduleId) || !isString(url) || !isString(identity))
      return undefined;
    parsed.push({ file, moduleId, url, identity, imports: stringsOf(imports) });
  }
  const shared: StoredShared[] = [];
  for (const entry of Array.isArray(record['shared']) ? record['shared'] : []) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { url, identity, importers } = entry as Record<string, unknown>;
    if (!isString(url) || !isString(identity)) return undefined;
    shared.push({ url, identity, importers: stringsOf(importers) });
  }
  const sheets = record['stylesheets'];
  // Absent in a 22.3.2 store: read as none, and the boot builds when it matters (see below).
  const stylesheets = Array.isArray(sheets) ? sheets.filter(isString) : [];
  return {
    framework: record['framework'],
    bun: record['bun'],
    chunks: parsed,
    shared,
    stylesheets,
  };
}

/** A verified store, or the one sentence saying why it cannot be served. */
export type StoreRead =
  | { readonly bundle: IslandBundle; readonly stale?: undefined }
  | { readonly bundle?: undefined; readonly stale: string };

export async function readIslandStore(root: string): Promise<StoreRead> {
  const dir = join(root, ISLAND_STORE_DIR);
  const file = Bun.file(join(dir, INDEX));
  if (!(await file.exists())) return { stale: `no ${ISLAND_STORE_DIR}/${INDEX}` };
  const index = parseIndex(await file.json().catch(() => undefined));
  if (index === undefined) return { stale: `${ISLAND_STORE_DIR}/${INDEX} does not parse` };
  if (index.framework !== frameworkVersion() || index.bun !== Bun.version) {
    return {
      stale: `built by framework ${index.framework} on Bun ${index.bun}, serving ${frameworkVersion()} on Bun ${Bun.version}`,
    };
  }
  const stored = index.chunks.map((chunk) => chunk.file).sort();
  const present = [...(await discoverIslands(root))];
  if (stored.join('\n') !== present.join('\n')) {
    return { stale: 'the stored islands are not the islands this app has' };
  }
  const verified = async (entry: { readonly url: string; readonly identity: string }) => {
    const bytes = Bun.file(join(dir, chunkFile(entry.url)));
    const code = (await bytes.exists()) ? await bytes.text() : undefined;
    return code === undefined || contentHash(code) !== entry.identity ? undefined : code;
  };
  const chunks: IslandChunk[] = [];
  for (const entry of index.chunks) {
    const code = await verified(entry);
    if (code === undefined) {
      return { stale: `${entry.url} is missing or does not match its recorded hash` };
    }
    chunks.push({
      file: entry.file,
      moduleId: entry.moduleId,
      url: entry.url,
      code,
      bytes: new TextEncoder().encode(code).byteLength,
      imports: entry.imports,
    });
  }
  const shared: SharedChunk[] = [];
  for (const entry of index.shared) {
    const code = await verified(entry);
    if (code === undefined) {
      return { stale: `${entry.url} is missing or does not match its recorded hash` };
    }
    shared.push({
      url: entry.url,
      code,
      bytes: new TextEncoder().encode(code).byteLength,
      importers: entry.importers,
    });
  }
  // An entry importing a chunk the store does not hold would boot to a 404 in every pod.
  const held = new Set(shared.map((chunk) => chunk.url));
  const orphan = chunks.flatMap((chunk) => chunk.imports).find((url) => !held.has(url));
  if (orphan !== undefined) return { stale: `${orphan}, a shared chunk, is not in the store` };
  // In sorted order, as `island` sheets: `stylesFor` orders those by path, so this is the same
  // surface stylesheet the build that wrote the store joined.
  for (const sheet of index.stylesheets) {
    const source = Bun.file(join(root, sheet));
    if (!(await source.exists())) return { stale: `${sheet}, an island stylesheet, is missing` };
    loadStylesheet(join(root, sheet), await source.text(), 'island');
  }
  return { bundle: islandBundle(chunks, shared) };
}

/** The container's islands, and — when this boot had to build them — why and how many. */
export interface LoadedIslands {
  readonly bundle: IslandBundle;
  readonly built?: { readonly chunks: number; readonly reason: string };
}

/**
 * The container's islands: the verified store, or a build when there is none to trust. A build is
 * correct and only slower, so a stale store is never a refusal — the caller is handed the reason,
 * and `serve-boot.ts` logs it once with everything else the boot built (`X_IMAGE_NOT_PREBUILT`).
 */
export async function loadOrBuildIslands(root: string): Promise<LoadedIslands> {
  const read = await readIslandStore(root);
  if (read.bundle !== undefined) return { bundle: read.bundle };
  const bundle = await buildIslands(root);
  return {
    bundle,
    built: { chunks: bundle.chunks.length + bundle.shared.length, reason: read.stale },
  };
}
