// The two generated contracts an app commits — `x.manifest.json` and `openapi.json` — written by one
// function, because two commands wrote them and only one wrote both: `x g` refreshed the manifest
// and left `openapi.json` behind, so its own output failed the `contract-diff` step next.

import { join } from 'node:path'; // why: Bun ships no path-join primitive.
import type { Manifest } from '@ultimat3/manifest';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { writeAppManifest } from './app-manifest';
import { OPENAPI_FILE, openApiJson } from './app-openapi';

export interface ArtifactOptions {
  /** `x manifest --no-openapi` writes the manifest alone. */
  readonly openapi: boolean;
  /**
   * Refresh only what is already committed. `x g` never introduces a generated file an app did not
   * ask to maintain; `x manifest` is the asking.
   */
  readonly onlyExisting: boolean;
}

/** Writes the app's generated contracts from one projection. Answers the app-relative paths. */
export async function writeAppArtifacts(
  root: string,
  manifest: Manifest,
  options: ArtifactOptions,
): Promise<readonly string[]> {
  const written: string[] = [];
  const present = async (file: string): Promise<boolean> =>
    !options.onlyExisting || (await Bun.file(join(root, file)).exists());
  if (await present(MANIFEST_FILENAME)) {
    await writeAppManifest(root, manifest);
    written.push(MANIFEST_FILENAME);
  }
  if (options.openapi && (await present(OPENAPI_FILE))) {
    await Bun.write(join(root, OPENAPI_FILE), openApiJson(manifest));
    written.push(OPENAPI_FILE);
  }
  return written;
}
