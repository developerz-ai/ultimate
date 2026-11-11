// One island build's outputs, turned into the chunk table: which output is which island's entry,
// the shared chunks each entry loads, and the files on disk each was built from. Split from
// `island-bundle.ts`, which runs the build; this only reads what the bundler emitted.

// why: Bun ships no path API; `posix` for Bun's output paths, `basename` for a module id.
import { basename, posix } from 'node:path';
import { islandModuleId } from '@ultimat3/render';
import { IslandBuildFailedError } from './errors';
import type { IslandChunk, SharedChunk } from './island-bundle';
import { sourcesContentOf, stableChunk, stripDebugId } from './island-identity';
import type { BuiltOutput, LinkedFile } from './island-link';
import { sharedChunkName } from './island-link';
import { REALTIME_ISLAND_ENTRY } from './island-realtime';
import type { SourcePaths } from './island-sources';
import { sourcesOnDisk } from './island-sources';

/**
 * Where a chunk is served from, in `x dev`, in the container and in a static export — one base
 * path, because the URL is minted by one resolver and baked into the document. Sits beside
 * `ICON_BASE_PATH` and `MEDIA_BASE_PATH`, deliberately outside the dev-only `/_x` namespace.
 */
export const ISLAND_BASE_PATH = '/islands';

/**
 * Bun's `./a/b.island.js` → `a/b.island.js`. A realtime wrapper's output is named after its
 * VIRTUAL entry, which Bun places relative to the cwd behind `_.._/` segments — so everything up to
 * and including the prefix goes, leaving the island's own spelling.
 */
const outputKey = (path: string): string => {
  const bare = path.startsWith('./') ? path.slice(2) : path;
  const at = bare.indexOf(REALTIME_ISLAND_ENTRY);
  return at === -1 ? bare : bare.slice(at + REALTIME_ISLAND_ENTRY.length);
};

const withoutExtension = (file: string): string =>
  file.slice(0, file.length - posix.extname(file).length);

/** Every code output paired with its source map's inputs and, for an entry, its island. */
export async function builtOutputs(
  root: string,
  files: readonly string[],
  artifacts: readonly Bun.BuildArtifact[],
  sourcePaths: Map<string, SourcePaths>,
): Promise<readonly BuiltOutput[]> {
  const byStem = new Map(files.map((file) => [withoutExtension(file), file]));
  const maps = new Map<string, string>();
  for (const artifact of artifacts) {
    if (artifact.kind === 'sourcemap') maps.set(artifact.path, await artifact.text());
  }
  const outputs: BuiltOutput[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== 'entry-point' && artifact.kind !== 'chunk') continue;
    const key = outputKey(artifact.path);
    const file = artifact.kind === 'entry-point' ? byStem.get(withoutExtension(key)) : undefined;
    const map = maps.get(`${artifact.path}.map`);
    const parsed: unknown = map === undefined ? undefined : JSON.parse(map);
    const sources = parsed === undefined ? undefined : sourcesContentOf(parsed, true);
    sourcePaths.set(key, await sourcesOnDisk(root, parsed));
    if (sources === undefined || (artifact.kind === 'entry-point' && file === undefined)) {
      throw new IslandBuildFailedError({
        file: file ?? key,
        logs: `the bundler emitted ${key} with no source map or no island behind it, so the output has no stable identity`,
      });
    }
    outputs.push({
      path: key,
      ...(file === undefined ? {} : { file }),
      code: stripDebugId(await artifact.text()),
      sources,
    });
  }
  return outputs;
}

/**
 * The entry's own file, added to sources the map resolved into the root. A pure re-export island
 * (`export { mountMenu as mount } from '../shared/menu'`) emits no code of its own, so its source
 * map names only what it re-exports: the store then recorded nothing that changes when the entry
 * is edited, and `writeIslandStore` refused it as a map whose paths left the root. A map that
 * resolved NOTHING into the root stays empty — that is the cwd failure, and it is still refused.
 */
function withOwnFile(file: string, sources: SourcePaths): SourcePaths {
  return sources.length === 0 || sources.includes(file) ? sources : [...sources, file].sort();
}

/** The linked outputs, as the chunk table: the entries in `files` order, their chunks attached. */
export function entryChunks(
  files: readonly string[],
  linked: readonly LinkedFile[],
  sources: ReadonlyMap<string, SourcePaths>,
): readonly IslandChunk[] {
  const shared = new Map(
    linked
      .filter((one) => one.file === undefined)
      .map((one) => [sharedChunkName(one.identity), one]),
  );
  const closure = (start: readonly string[]): readonly string[] => {
    const seen = new Set<string>();
    const walk = (names: readonly string[]): void => {
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        walk(shared.get(name)?.imports ?? []);
      }
    };
    walk(start);
    return [...seen].sort().map((name) => `${ISLAND_BASE_PATH}/${name}`);
  };
  const chunks: IslandChunk[] = [];
  for (const file of files) {
    const entry = linked.find((one) => one.file === file);
    if (entry === undefined) {
      throw new IslandBuildFailedError({ file, logs: 'the bundler emitted no entry point for it' });
    }
    const moduleId = islandModuleId(basename(file));
    chunks.push({
      file,
      moduleId,
      url: `${ISLAND_BASE_PATH}/${moduleId}-${entry.identity}.js`,
      // The FIRST bytes this process emitted for these inputs, so a URL served `immutable` answers
      // one byte string for as long as the process lives. Without it `x dev` re-mints the chunk on
      // every watcher tick and a browser holding the previous one under `max-age=31536000` has two
      // different files at one address. `bytes` is measured on THAT code, never on this build's.
      ...stableChunk(file, entry.identity, entry.code),
      imports: closure(entry.imports),
      sources: withOwnFile(file, sources.get(entry.path) ?? []),
    });
  }
  return chunks;
}

/** Every shared chunk the entries load, pinned the same way, with the islands that load it. */
export function sharedChunks(
  chunks: readonly IslandChunk[],
  linked: readonly LinkedFile[],
  sources: ReadonlyMap<string, SourcePaths>,
): readonly SharedChunk[] {
  const out: SharedChunk[] = [];
  for (const one of linked) {
    if (one.file !== undefined) continue;
    const url = `${ISLAND_BASE_PATH}/${sharedChunkName(one.identity)}`;
    out.push({
      url,
      ...stableChunk(url, one.identity, one.code),
      importers: chunks
        .filter((chunk) => chunk.imports.includes(url))
        .map((chunk) => chunk.file)
        .sort(),
      sources: sources.get(one.path) ?? [],
    });
  }
  return out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}
