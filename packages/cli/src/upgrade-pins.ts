// Where an app's `@ultimat3/*` pins live: the root manifest and every workspace's. Reading and writing
// go through one pattern, so the set the plan judged is the set the hop moves — `overrides` and
// `resolutions` included, since an override left behind holds the old version in place.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { pinVersion, type UpgradePin } from './upgrade-plan';
import { workspaceGlobs, workspaceManifestPaths } from './workspace-graph';

const ROOT_MANIFEST = 'package.json';

export interface WorkspaceManifest {
  /** Relative to the app root, POSIX. */
  readonly file: string;
  readonly text: string;
}

const PIN_ENTRY = /("(@ultimat3\/[a-z0-9-]+)"\s*:\s*")([^"]*)(")/g;

/** A manifest's JSON, or X_UPGRADE_PIN_UNREADABLE naming the file: never a raw SyntaxError. */
export const parseManifest = (file: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new UltimateError({
      code: 'X_UPGRADE_PIN_UNREADABLE',
      cause: `${file} is not valid JSON, so its @ultimat3/* pins cannot be read`,
      fix: `bun install   # names the line in ${file} to repair; then: x upgrade --json`,
    });
  }
};

/** The root manifest and every workspace's, read once, as text: the hop edits the text. */
export async function readManifests(root: string): Promise<readonly WorkspaceManifest[]> {
  const rootText = await Bun.file(join(root, ROOT_MANIFEST)).text();
  const files = await workspaceManifestPaths(
    root,
    workspaceGlobs(parseManifest(ROOT_MANIFEST, rootText)),
  );
  const members = await Promise.all(
    files
      .filter((file) => file !== ROOT_MANIFEST)
      .map(async (file) => ({ file, text: await Bun.file(join(root, file)).text() })),
  );
  return [{ file: ROOT_MANIFEST, text: rootText }, ...members];
}

export function readPins(manifests: readonly WorkspaceManifest[]): readonly UpgradePin[] {
  return manifests.flatMap(({ file, text }) =>
    [...text.matchAll(PIN_ENTRY)].map(([, , name = '', spec = '']) => ({ file, name, spec })),
  );
}

/**
 * Every pin at the exact version, the rest of the file byte-identical. Exact whatever it was: a
 * caret is how `^19.0.0` beside `^19.4.0` came to be mixed, and a range is a silent upgrade.
 * A spec naming no version never reaches here (`planHop` refused it), and is left as written.
 */
export const rewritePins = (text: string, to: string): string =>
  text.replace(PIN_ENTRY, (whole, head: string, _name: string, spec: string, tail: string) =>
    pinVersion(spec) === undefined ? whole : `${head}${to}${tail}`,
  );
