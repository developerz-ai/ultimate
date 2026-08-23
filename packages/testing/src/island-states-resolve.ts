// Resolution, in the two directions a caller needs it: a NAME a reader typed → the manifest it
// meant, and a manifest → the island file it claims on disk. Loose on the way in and strict on the
// way out — a typo must never be a silent miss, so an unresolved name lists every valid one.

import { join } from 'node:path'; // why: no Bun native joins a path; `Bun.file` takes one already joined.
import {
  IslandStatesAmbiguousError,
  IslandStatesMissingFileError,
  IslandStatesUnknownError,
} from './island-state-errors';
import type { IslandStatesManifest } from './island-states';

/**
 * `Settings`, `settings`, `settings.island.tsx` and `apps/web/app/settings/settings.island.tsx` are
 * one name. Case and separators are dropped because a reader types the component the way it is
 * spelled in JSX and the file the way it is spelled on disk, and neither is wrong.
 */
export function normalizeIslandName(value: string): string {
  const base = value.split('/').pop() ?? value;
  const stem = base.split('.')[0] ?? base;
  return stem.toLowerCase().replace(/[^a-z\d]+/g, '');
}

/** Every name a reader may type, in manifest order — what an unresolved lookup reports back. */
export const islandStatesNames = (all: readonly IslandStatesManifest[]): readonly string[] =>
  all.map((manifest) => manifest.name);

/** Manifests answering to `name`. Zero and two are both failures, and different ones. */
export function islandStatesMatching(
  all: readonly IslandStatesManifest[],
  name: string,
): readonly IslandStatesManifest[] {
  const wanted = normalizeIslandName(name);
  return all.filter((manifest) => normalizeIslandName(manifest.name) === wanted);
}

/**
 * The one refusal in this vocabulary. Everything downstream falls back — a mistyped THEME still
 * shows the component — but a name nothing answers to has no defensible fallback: photographing
 * some other island would be a picture that reads as an answer.
 */
export function findIslandStates(
  all: readonly IslandStatesManifest[],
  name: string,
): IslandStatesManifest {
  const matches = islandStatesMatching(all, name);
  const first = matches[0];
  if (first === undefined) {
    throw new IslandStatesUnknownError({ name, known: islandStatesNames(all) });
  }
  if (matches.length > 1) {
    throw new IslandStatesAmbiguousError({
      name,
      islands: matches.map((manifest) => manifest.island),
    });
  }
  return first;
}

/**
 * Two manifests one name would resolve to. Asked of the whole SET, once, rather than discovered by
 * a lookup that happens to be made: two islands sharing a basename also share a shot directory, so
 * the collision loses pictures whether or not anyone ever types the ambiguous name.
 */
export function assertUniqueIslandStates(all: readonly IslandStatesManifest[]): void {
  const byName = new Map<string, IslandStatesManifest[]>();
  for (const manifest of all) {
    const key = normalizeIslandName(manifest.name);
    byName.set(key, [...(byName.get(key) ?? []), manifest]);
  }
  for (const [name, group] of byName) {
    if (group.length > 1) {
      throw new IslandStatesAmbiguousError({
        name,
        islands: group.map((manifest) => manifest.island),
      });
    }
  }
}

/**
 * Declared islands with no file under `root`. Not part of `defineIslandStates`: a declaration is
 * evaluated wherever the module is imported from, and a rule that reads the filesystem at import
 * time fails on the cwd rather than on the path. The check belongs where a root is known — the
 * guard test, and the command that takes the pictures.
 */
export async function missingIslandFiles(
  all: readonly IslandStatesManifest[],
  root: string,
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const manifest of all) {
    if (!(await Bun.file(join(root, manifest.island)).exists())) missing.push(manifest.island);
  }
  return missing;
}

/** The same check as a refusal, naming the first island that is not there. */
export async function assertIslandFiles(
  all: readonly IslandStatesManifest[],
  root: string,
): Promise<void> {
  const missing = await missingIslandFiles(all, root);
  const first = missing[0];
  if (first !== undefined) throw new IslandStatesMissingFileError({ island: first, root });
}
