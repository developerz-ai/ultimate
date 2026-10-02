// The two halves of an image build that are this framework's. On the host, `x build --target
// docker` stamps the image with the manifest's build id. INSIDE the image build, `x build --target
// prebuilt` writes what every web pod would otherwise make on every boot: the island chunks and
// the compiled stylesheets (`serve-prebuilt-paths.ts` names the store and why it is where it is).

// why: Bun ships no recursive remove; a previous store must not survive beside the new one.
import { rm } from 'node:fs/promises';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { sassCompilations, setSassCacheDir } from '@ultimat3/render/server';
import { scanAppModules } from './app-load';
import { appManifest } from './app-manifest';
import { buildIslands } from './island-bundle';
import { writeIslandStore } from './island-store';
import type { Finding } from './output';
import { PREBUILT_DIR, PREBUILT_SASS_DIR } from './serve-prebuilt-paths';

/** The build id `docker build` is handed as `--build-arg BUILD_ID=…`. */
export async function imageBuildId(root: string): Promise<string> {
  return (await appManifest(root)).manifest.buildId;
}

export interface PrebuiltImage {
  /** App-root-relative, POSIX. */
  readonly dir: string;
  /** Island chunks written, shared chunks included. */
  readonly islands: number;
  /** Stylesheets compiled into the store. */
  readonly stylesheets: number;
  /** A module that would not import: its stylesheets are not in the store. */
  readonly findings: readonly Finding[];
}

/**
 * Where it runs is the design. The store is valid for one Bun, one framework version and one set
 * of absolute paths — a chunk is verified against the runtime that built it, and a Sass entry is
 * keyed by the sheet's path — so it is written by the image's own Bun, at the image's own
 * `WORKDIR`, after the source is in place. Built on a laptop and copied in, it was a store for a
 * different runtime; and under `.x/` it was dropped by the ignore file before that mattered.
 *
 * The app is imported the way the web role imports it (`scanAppModules`, every module), because
 * importing a page is what compiles its stylesheet: what this scan compiles is what a pod reads.
 */
export async function prebuildImage(root: string): Promise<PrebuiltImage> {
  await rm(join(root, PREBUILT_DIR), { recursive: true, force: true });
  setSassCacheDir(join(root, PREBUILT_SASS_DIR));
  const compiled = sassCompilations();
  const scan = await scanAppModules(root, { track: false });
  const bundle = await buildIslands(root);
  await writeIslandStore(root, bundle);
  return {
    dir: PREBUILT_DIR,
    islands: bundle.chunks.length + bundle.shared.length,
    stylesheets: sassCompilations() - compiled,
    findings: scan.findings,
  };
}
