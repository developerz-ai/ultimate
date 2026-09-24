// The island chunks a container serves, built ONCE by `x build --target docker` into
// `.x/islands/` and read back at boot. Without it every role's boot ran `Bun.build` — Babel, the
// JSX transform, a minifier — for every island, in the image, on every start, and a chunk whose
// URL is a hash of its sources was rebuilt from sources that could not have changed.
//
// Load-and-VERIFY, never load-and-trust: a store written by another framework or Bun version, one
// that names a different set of islands than the app has, or a chunk whose bytes do not hash to
// what the index recorded is refused, and the boot builds instead — with the reason logged.

import { join } from 'node:path'; // why: Bun ships no path-join primitive.
import { frameworkVersion, logger } from '@ultimat3/core';
import { contentHash } from '@ultimat3/render/server';
import type { IslandBundle, IslandChunk } from './island-bundle';
import { buildIslands, discoverIslands, islandBundle } from './island-bundle';

/** App-root-relative: `COPY . .` carries it into the image with the rest of `.x/`. */
export const ISLAND_STORE_DIR = '.x/islands';
const INDEX = 'index.json';

interface StoredChunk {
  readonly file: string;
  readonly moduleId: string;
  readonly url: string;
  readonly identity: string;
}

interface StoreIndex {
  readonly framework: string;
  readonly bun: string;
  readonly chunks: readonly StoredChunk[];
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
    });
  }
  const index: StoreIndex = { framework: frameworkVersion(), bun: Bun.version, chunks };
  await Bun.write(join(dir, INDEX), `${JSON.stringify(index, null, 2)}\n`);
  return [...written, `${ISLAND_STORE_DIR}/${INDEX}`];
}

const isString = (value: unknown): value is string => typeof value === 'string';

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
    const { file, moduleId, url, identity } = chunk;
    if (!isString(file) || !isString(moduleId) || !isString(url) || !isString(identity))
      return undefined;
    parsed.push({ file, moduleId, url, identity });
  }
  return { framework: record['framework'], bun: record['bun'], chunks: parsed };
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
  const chunks: IslandChunk[] = [];
  for (const entry of index.chunks) {
    const bytes = Bun.file(join(dir, chunkFile(entry.url)));
    const code = (await bytes.exists()) ? await bytes.text() : undefined;
    if (code === undefined || contentHash(code) !== entry.identity) {
      return { stale: `${entry.url} is missing or does not match its recorded hash` };
    }
    chunks.push({
      file: entry.file,
      moduleId: entry.moduleId,
      url: entry.url,
      code,
      bytes: new TextEncoder().encode(code).byteLength,
    });
  }
  return { bundle: islandBundle(chunks) };
}

/**
 * The container's islands: the verified store, or a build when there is none to trust. A build is
 * correct and only slower, so a stale store is a warning with its reason, never a refusal.
 */
export async function loadOrBuildIslands(root: string): Promise<IslandBundle> {
  const read = await readIslandStore(root);
  if (read.bundle !== undefined) return read.bundle;
  logger.warn('islands built at boot', {
    reason: read.stale,
    fix: 'x build --target docker',
  });
  return buildIslands(root);
}
