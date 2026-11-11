// Single responsibility: what a `bun build --compile` that BUNDLES core adds so the raster Worker
// starts inside the executable — the worker file as an extra entrypoint, and the define naming
// where Bun puts it. Bun detects no `new Worker(…)` target on its own (measured, 1.4.4).

// why: Bun has no path primitives; the embedded path is a relative() between two real paths.
import { relative, resolve, sep } from 'node:path';

/** The define `raster-pool.ts` reads inside a compiled executable — one name, both sides. */
export const RASTER_WORKER_DEFINE = 'ULTIMATE_RASTER_WORKER';

/** The worker file on disk: the extra entrypoint. */
export const RASTER_WORKER_ENTRY: string = resolve(import.meta.dir, 'raster-worker.ts');

export interface RasterWorkerBundle {
  /** Pass beside the executable's own entry: `entrypoints: [entry, bundle.entrypoint]`. */
  readonly entrypoint: string;
  /** Merge into the build's `define`. */
  readonly define: Readonly<Record<string, string>>;
}

/** The deepest directory holding every path: where Bun roots `/$bunfs/root/` with no `root` set. */
function commonDirectory(paths: readonly string[]): string {
  const split = paths.map((path) => path.split(sep));
  const first = split[0] ?? [];
  let depth = 0;
  // Every path is a FILE, so its last segment never counts as a shared directory.
  while (
    depth < first.length - 1 &&
    split.every((parts) => depth < parts.length - 1 && parts[depth] === first[depth])
  ) {
    depth += 1;
  }
  return first.slice(0, depth).join(sep) || sep;
}

/**
 * For a compile whose own entrypoints are `entrypoints`: the worker entrypoint to add, and the
 * define that tells the bundled `raster-pool.ts` its path. Bun embeds each entrypoint at its path
 * relative to the deepest directory shared by all of them, and resolves a `./` specifier from
 * there (measured: `new Worker('./b/w.ts')` starts a worker compiled from `<root>/b/w.ts`).
 */
export function rasterWorkerBundle(entrypoints: readonly string[]): RasterWorkerBundle {
  const root = commonDirectory([
    ...entrypoints.map((entry) => resolve(entry)),
    RASTER_WORKER_ENTRY,
  ]);
  const inside = relative(root, RASTER_WORKER_ENTRY).split(sep).join('/');
  return {
    entrypoint: RASTER_WORKER_ENTRY,
    define: { [RASTER_WORKER_DEFINE]: JSON.stringify(`./${inside}`) },
  };
}
