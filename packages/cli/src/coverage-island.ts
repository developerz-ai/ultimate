// One coverage slice's island chunks, folded into its per-file facts: the source maps `mountIsland`
// recorded under `ISLAND_COVERAGE_ENV`, read, and each chunk's lcov record credited back to the
// app sources it was built from (`coverage-remap.ts`).

// why: Bun ships no directory-exists probe (`Bun.file` answers files only).
import { existsSync } from 'node:fs';
// why: Bun ships no path API; `posix` names a module, `resolve`/`relative` key a map's sources.
import { join, posix, relative, resolve, sep } from 'node:path';
import type { CoverageMap, FileCoverage, LcovRecord } from './coverage-lcov';
import type { ChunkLines, ChunkMap } from './coverage-remap';
import { chunkLines, withChunkLines } from './coverage-remap';
import { readSource } from './coverage-source';

/** The subdirectory of a slice's coverage directory its island maps land in. */
export const ISLAND_MAPS_DIR = 'islands';

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((one) => typeof one === 'string') ? value : undefined;

/**
 * One sidecar `{ module, cwd, map }` as a `ChunkMap`, or nothing when it is not one — a map the
 * builder handed over malformed credits no line, so the floor reads LOWER, never higher.
 */
export function parseChunkMap(text: string): ChunkMap | undefined {
  let outer: unknown;
  let map: unknown;
  try {
    outer = JSON.parse(text);
    const raw = (outer as Record<string, unknown> | null)?.['map'];
    map = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
  const { module, cwd } = (outer ?? {}) as { module?: unknown; cwd?: unknown };
  const { sources, sourcesContent, mappings } = (map ?? {}) as Record<string, unknown>;
  const listed = strings(sources);
  if (typeof module !== 'string' || typeof cwd !== 'string' || typeof mappings !== 'string') {
    return undefined;
  }
  if (listed === undefined || !Array.isArray(sourcesContent)) return undefined;
  return {
    module,
    // Bun writes each source relative to the BUILDING process's cwd (`island-sources.ts`).
    sources: listed.map((one) => resolve(cwd, one).split(sep).join('/')),
    sourcesContent: sourcesContent.map((one: unknown) =>
      typeof one === 'string' ? one : undefined,
    ),
    mappings,
  };
}

/** Every map one slice recorded, by the module name its `SF:` line ends in. */
export async function readChunkMaps(dir: string): Promise<ReadonlyMap<string, ChunkMap>> {
  const out = new Map<string, ChunkMap>();
  const at = join(dir, ISLAND_MAPS_DIR);
  // Absent: the slice mounted no island with a map, so there is nothing to fold.
  if (!existsSync(at)) return out;
  for await (const name of new Bun.Glob('*.json').scan({ cwd: at })) {
    const parsed = parseChunkMap(await Bun.file(join(at, name)).text());
    if (parsed !== undefined) out.set(parsed.module, parsed);
  }
  return out;
}

/** The app's coverage key for an absolute path, when it is the app's own source. */
const appKey =
  (root: string) =>
  (absolute: string): string | undefined => {
    const key = relative(root, absolute).split(sep).join('/');
    return /^(?:apps|packages)\//.test(key) && !key.includes('/node_modules/') ? key : undefined;
  };

/** One slice's lcov records and the island maps it recorded. */
export interface ChunkPart {
  readonly records: readonly LcovRecord[];
  readonly maps: ReadonlyMap<string, ChunkMap>;
}

/**
 * `merged` — every slice's direct records already folded — with every chunk record that has a map
 * credited to the sources behind it. After the fold, never per slice: a source one slice only
 * mounted and another loaded directly then has the direct line set, rather than two line sets
 * the fold would reconcile by dropping the misses one of them did not list. A record whose module
 * has no map is left alone — a framework file or an island built without one.
 */
export async function withIslandChunks(
  root: string,
  merged: CoverageMap,
  parts: readonly ChunkPart[],
): Promise<CoverageMap> {
  if (parts.every((part) => part.maps.size === 0)) return merged;
  const texts = new Map<string, string | undefined>();
  const credited = new Map<string, { hit: Set<number>; miss: Set<number> }>();
  for (const { records, maps } of parts)
    for (const record of records) {
      const map = maps.get(posix.basename(record.file));
      if (map === undefined) continue;
      for (const source of map.sources) {
        const key = appKey(root)(source);
        if (key !== undefined && !texts.has(key)) texts.set(key, await readSource(root, key));
      }
      for (const [key, lines] of chunkLines(record, map, appKey(root), (k) => texts.get(k))) {
        const into = credited.get(key) ?? { hit: new Set<number>(), miss: new Set<number>() };
        for (const line of lines.hit) into.hit.add(line);
        for (const line of lines.miss) into.miss.add(line);
        credited.set(key, into);
      }
    }
  const out: Record<string, FileCoverage> = { ...merged };
  for (const [key, lines] of credited) {
    const source = texts.get(key);
    if (source === undefined) continue;
    const settled: ChunkLines = {
      hit: lines.hit,
      miss: new Set([...lines.miss].filter((line) => !lines.hit.has(line))),
    };
    out[key] = withChunkLines(merged[key], settled);
  }
  return out;
}
