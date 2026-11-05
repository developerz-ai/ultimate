// The two projections `x g` keeps current after a write, for `x g sign-in`: `x.manifest.json` and
// `openapi.json`, refreshed only where the app already keeps them — the same rule `cmd-generate.ts`
// holds, so a generator never hands an app a generated file it did not ask to maintain.

import { existsSync } from 'node:fs'; // why: Bun has no synchronous existence check.
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { writeAppArtifacts } from './app-artifacts';
import { appManifest } from './app-manifest';
import { containedPath } from './generate-write';
import type { Finding } from './output';

/** The projections a real run would rewrite: the ones the app already keeps. */
export const existingArtifacts = async (root: string): Promise<readonly string[]> =>
  [MANIFEST_FILENAME, 'openapi.json'].filter((file) => existsSync(containedPath(root, file)));

export interface Refreshed {
  readonly written: readonly string[];
  /** A module that would not load withholds the projection, and says so. */
  readonly findings: readonly Finding[];
}

export async function appManifestIfAny(root: string): Promise<Refreshed> {
  if (!existsSync(containedPath(root, MANIFEST_FILENAME))) return { written: [], findings: [] };
  const { manifest, findings } = await appManifest(root);
  if (findings.length > 0) return { written: [], findings };
  const written = await writeAppArtifacts(root, manifest, { openapi: true, onlyExisting: true });
  return { written, findings: [] };
}
