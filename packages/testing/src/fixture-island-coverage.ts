// What `mountIsland` leaves behind for coverage: each chunk's source map, written where the
// coverage run asked, under the file name the chunk was imported by. The run (`@ultimat3/cli`'s
// `coverage-island.ts`) reads them and credits the chunk's lines to the island's own source.

// why: Bun ships no path-join primitive.
import { join } from 'node:path';

/** Set by `x verify`'s coverage run (`@ultimat3/cli`'s `runCovered`) to a directory per process. */
export const ISLAND_COVERAGE_ENV = 'ULTIMATE_ISLAND_COVERAGE_DIR';

/** The directory to record into, or nothing outside a coverage run. */
export const islandCoverageDir = (
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string | undefined => {
  const dir = env[ISLAND_COVERAGE_ENV];
  return dir === undefined || dir === '' ? undefined : dir;
};

/**
 * One chunk's map, as `{ module, cwd, map }`. The map is kept as the builder's text: its `sources`
 * are relative to THIS process's cwd (Bun's convention), which is why the cwd rides beside it.
 * Named by the module, so a second mount of the same bytes rewrites the same file.
 */
export async function recordChunkMap(dir: string, module: string, map: string): Promise<void> {
  await Bun.write(join(dir, `${module}.json`), JSON.stringify({ module, cwd: process.cwd(), map }));
}
