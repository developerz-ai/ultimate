// What `x build --target docker` does before `docker build`: stamp the image with the manifest's
// build id and write the island chunks it will serve (`island-store.ts`), so a container boot
// neither re-derives the one nor rebuilds the other.

import { appManifest } from './app-manifest';
import { buildIslands } from './island-bundle';
import { writeIslandStore } from './island-store';

/** Writes `.x/islands/` and answers the build id the image is stamped with. */
export async function prepareImage(root: string): Promise<string> {
  const { manifest } = await appManifest(root);
  await writeIslandStore(root, await buildIslands(root));
  return manifest.buildId;
}
