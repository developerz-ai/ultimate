// The image's prebuilt store, as a container sees it: where `x build --target prebuilt` wrote the
// island chunks and the compiled stylesheets during `docker build`, and the one log line a role
// owes when it had to build either at boot instead. A leaf of the boot graph — the half that
// WRITES the store (`image-prepare.ts`) carries the island builder and is never loaded here.

// why: the store is adopted before the first app module is imported, and that import path is
// synchronous end to end (`compileStylesheet` runs inside Bun's `onLoad`); Bun has no sync exists.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { Role } from '@ultimat3/core';
import { logger, UltimateError } from '@ultimat3/core';
import { sassCompilations, setSassCacheDir } from '@ultimat3/render/server';
import { PREBUILT_COMMAND, PREBUILT_SASS_DIR } from './serve-prebuilt-paths';

/**
 * Points the Sass cache at the image's own entries, when the image has any. Before the app is
 * imported, because importing a page IS compiling its stylesheet. An entry is keyed by the
 * sheet's absolute path, which is why the store is written inside the image build: same `WORKDIR`,
 * same paths. Answers whether there was a store to adopt.
 */
export function adoptPrebuiltStyles(root: string): boolean {
  const dir = join(root, PREBUILT_SASS_DIR);
  if (!existsSync(dir)) return false;
  setSassCacheDir(dir);
  return true;
}

/** What a role built at boot that the image build exists to have built once. */
export interface BootBuilds {
  /** Island chunks built by this boot, and the one sentence saying why the store was not served. */
  readonly islands?: { readonly chunks: number; readonly reason: string };
  /** Stylesheets this boot ran Sass for. */
  readonly stylesheets: number;
  readonly elapsedMs: number;
}

/**
 * Logged, never thrown: a build at boot is correct and only slow, so the role serves what it
 * would have served — it pays seconds of CPU and a compiler's worth of memory on every start.
 */
export class ImageNotPrebuiltError extends UltimateError {
  constructor(input: { readonly role: Role } & BootBuilds) {
    const islands = input.islands;
    const built = [
      ...(islands === undefined
        ? []
        : [`built ${String(islands.chunks)} island chunk(s) because ${islands.reason}`]),
      ...(input.stylesheets === 0
        ? []
        : [`compiled ${String(input.stylesheets)} stylesheet(s) the image holds no result for`]),
    ];
    super({
      code: 'X_IMAGE_NOT_PREBUILT',
      cause: `the ${input.role} role ${built.join(' and ')}, ${String(input.elapsedMs)} ms into its boot — work this image repeats on every start of every replica`,
      fix: `edit docker/Dockerfile: add RUN ${PREBUILT_COMMAND} after COPY . . in the runtime stage, then rebuild the image`,
      meta: {
        role: input.role,
        islands: islands?.chunks ?? 0,
        stylesheets: input.stylesheets,
        elapsedMs: input.elapsedMs,
      },
    });
  }
}

/** Starts counting what a boot compiles; the answer is what `reportBootBuilds` is handed. */
export function watchBootBuilds(): (islands?: BootBuilds['islands']) => BootBuilds {
  const started = Bun.nanoseconds();
  const compiled = sassCompilations();
  return (islands) => ({
    ...(islands === undefined || islands.chunks === 0 ? {} : { islands }),
    stylesheets: sassCompilations() - compiled,
    elapsedMs: Math.round((Bun.nanoseconds() - started) / 1e6),
  });
}

/** One `error` line when the boot built anything, and nothing when it built nothing. */
export function reportBootBuilds(role: Role, builds: BootBuilds): boolean {
  if (builds.islands === undefined && builds.stylesheets === 0) return false;
  const error = new ImageNotPrebuiltError({ role, ...builds });
  logger.error(error.format(), { code: error.code, ...error.meta });
  return true;
}
