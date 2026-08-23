// Step one of photographing an island: find every `*.island.states.ts` in the app, prove each is
// pure data BEFORE importing it, and hand back the manifests. It happens with no browser and no
// dev server on purpose — the complete expected picture list has to exist before a capture starts,
// or "produced nothing and exited 0" is a result nobody can tell from success.

// why: no Bun native joins a path or relativises one; `Bun.file` and `import()` both take one joined.
import { join, relative, sep } from 'node:path';
import { ISLAND_EXTENSION } from '@ultimat3/render';
import type { IslandStatesManifest } from '@ultimat3/testing';
import {
  assertIslandFiles,
  assertIslandStatesPure,
  assertUniqueIslandStates,
  isIslandStatesManifest,
  islandStatesFile,
} from '@ultimat3/testing';
import { ISLAND_GLOB } from './island-bundle';
import { IslandStatesFileEmptyError } from './island-shot-errors';

/**
 * `.island.states.ts`, built from the two constants that own its halves and restated as neither:
 * `@ultimat3/render` owns the island extension and `@ultimat3/testing` owns what a states file
 * beside one is called. A third spelling here is the drift the derivation exists to prevent.
 */
export const ISLAND_STATES_SUFFIX = islandStatesFile(ISLAND_EXTENSION);

/**
 * `ISLAND_GLOB` with the island extension swapped for the states suffix, so a states file is
 * discovered exactly where its island is and nowhere else. One shape, derived, never a second
 * glob: a states file the discovery misses is a state nobody photographs and nothing says so —
 * which is what `findIslandStates` listing every declared name is the backstop for.
 */
export const ISLAND_STATES_GLOB = ISLAND_GLOB.replace(ISLAND_EXTENSION, ISLAND_STATES_SUFFIX);

/** App-root-relative POSIX paths of every states file, sorted, so a run is reproducible. */
export async function discoverIslandStates(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const scan = new Bun.Glob(ISLAND_STATES_GLOB).scan({ cwd: root, absolute: true });
  for await (const absolute of scan) {
    if (absolute.includes('node_modules')) continue;
    files.push(relative(root, absolute).split(sep).join('/'));
  }
  return files.sort();
}

/**
 * One file's manifests. The purity check runs against the file's TEXT and BEFORE the import,
 * which is the whole reason the rule is static: a states file that imports Solid evaluates
 * perfectly well under Bun, so nothing about loading it can notice, and by the time it has been
 * loaded the damage — a module graph that needs a browser — is already done.
 */
async function manifestsIn(root: string, file: string): Promise<readonly IslandStatesManifest[]> {
  const absolute = join(root, file);
  assertIslandStatesPure(file, await Bun.file(absolute).text());
  const module: unknown = await import(absolute);
  const exported = typeof module === 'object' && module !== null ? Object.values(module) : [];
  const found = exported.filter(isIslandStatesManifest);
  // A file named `*.island.states.ts` that exports no manifest is the same silence one level up:
  // it expands to no picture, and a run over it reports success having photographed nothing.
  if (found.length === 0) throw new IslandStatesFileEmptyError({ file });
  return found;
}

/**
 * Every manifest this app declares, checked as a SET: two islands answering to one name share a
 * shot directory (`assertUniqueIslandStates`), and a manifest naming a file that is not on disk
 * expands to pictures that can never be taken (`assertIslandFiles`). Both are asked once here
 * rather than discovered by whichever lookup happens to be made.
 */
export async function loadIslandStates(root: string): Promise<readonly IslandStatesManifest[]> {
  const all: IslandStatesManifest[] = [];
  for (const file of await discoverIslandStates(root)) {
    all.push(...(await manifestsIn(root, file)));
  }
  assertUniqueIslandStates(all);
  await assertIslandFiles(all, root);
  return all;
}
