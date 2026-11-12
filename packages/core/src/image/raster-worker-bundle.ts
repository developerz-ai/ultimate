// Single responsibility: what a `bun build --compile` that BUNDLES core adds so the raster Worker
// starts inside the executable — the worker file as an extra entrypoint, the build `root`, and the
// define naming where Bun puts it. Bun detects no `new Worker(…)` target on its own (measured, 1.4.4).

// why: Bun has no path primitives; the embedded path is a relative() between two real paths.
import * as hostPath from 'node:path';
import { assert } from '../assert';

/** A path flavour — `node:path` itself, or its `win32` / `posix` twin. */
type PlatformPath = typeof hostPath.posix;

/** The define `raster-pool.ts` reads inside a compiled executable — one name, both sides. */
export const RASTER_WORKER_DEFINE = 'ULTIMATE_RASTER_WORKER';

/** The worker file on disk: the extra entrypoint. */
export const RASTER_WORKER_ENTRY: string = hostPath.resolve(import.meta.dir, 'raster-worker.ts');

export interface RasterWorkerBundle {
  /** Pass beside the executable's own entry: `entrypoints: [entry, bundle.entrypoint]`. */
  readonly entrypoint: string;
  /**
   * Pass as `Bun.build`'s `root`. Stated rather than left to Bun's inference: the define is a path
   * relative to it, and a guessed root that differs by one directory is a Worker that never loads.
   */
  readonly root: string;
  /** Merge into the build's `define`. */
  readonly define: Readonly<Record<string, string>>;
}

/**
 * The deepest directory holding every path, or `undefined` when they share none — two Windows
 * drives. A drive root keeps its separator: `D:` alone means "the current directory on D:".
 */
function commonDirectory(path: PlatformPath, paths: readonly string[]): string | undefined {
  const { sep } = path;
  // Windows compares paths without case (`C:\` is `c:\`); POSIX does not.
  const samePart = (a: string | undefined, b: string | undefined): boolean =>
    sep === '\\' ? a?.toLowerCase() === b?.toLowerCase() : a === b;
  const split = paths.map((one) => one.split(sep));
  const first = split[0] ?? [];
  let depth = 0;
  // Every path is a FILE, so its last segment never counts as a shared directory.
  while (
    depth < first.length - 1 &&
    split.every((parts) => depth < parts.length - 1 && samePart(parts[depth], first[depth]))
  ) {
    depth += 1;
  }
  if (depth === 0) return undefined;
  const joined = first.slice(0, depth).join(sep);
  return depth === 1 ? `${joined}${sep}` : joined;
}

/**
 * For a compile whose own entrypoints are `entrypoints`: the worker entrypoint to add, the root to
 * build from, and the define that tells the bundled `raster-pool.ts` its path. Bun embeds each
 * entrypoint at its path relative to `root` and resolves a `./` specifier from there (measured:
 * with `root` set, `new Worker('./proj/b/w.ts')` starts the worker compiled from
 * `<root>/proj/b/w.ts`, and `./b/w.ts` does not).
 */
export function rasterWorkerBundle(entrypoints: readonly string[]): RasterWorkerBundle {
  return workerLayout(hostPath, entrypoints, RASTER_WORKER_ENTRY);
}

/** The rule with the platform's path flavour passed in, so the Windows half is tested on any host. */
export function workerLayout(
  path: PlatformPath,
  entrypoints: readonly string[],
  worker: string,
): RasterWorkerBundle {
  const all = [...entrypoints.map((entry) => path.resolve(entry)), worker];
  const root = commonDirectory(path, all);
  assert(
    root !== undefined,
    `the compile's entrypoints and @ultimat3/core share no directory (${all.join(', ')}), so no build root embeds the raster worker at a path the executable can name`,
    'move the entry onto the same drive as node_modules/@ultimat3/core, then compile again: bun run scripts/compile-x.ts --outfile <path>',
  );
  // Forward slashes on every platform: it is a module specifier, not a file-system path.
  const inside = path.relative(root, worker).split(path.sep).join('/');
  return {
    entrypoint: worker,
    root,
    define: { [RASTER_WORKER_DEFINE]: JSON.stringify(`./${inside}`) },
  };
}
