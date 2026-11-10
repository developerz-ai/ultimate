// A serving role's import of the app from the image's prebuilt registry (`build-registry.ts`):
// the chunks `x build --target prebuilt` wrote — every module's, or the background roles' subset —
// imported in order and registered, with no import scan and no document-graph walk. `undefined`
// whenever the registry cannot be trusted to be the app, so the caller scans instead.

// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { logger, UltimateError } from '@ultimat3/core';
import type { AppScan } from './app-load';
import { prepareAppImport, scannedModulePaths } from './app-load';
import type { OnEvaluated } from './app-load-batch';
import { receiving } from './app-load-batch';
import { registerModule } from './app-load-register';
import type { RegistryChunks } from './build-registry';
import { moduleStamp, readPrebuiltRegistry, registryDir } from './build-registry';
import type { Finding } from './output';
import { posixRelative } from './posix-path';
import type { RoleLoad } from './role-load';
import { PREBUILT_COMMAND } from './serve-prebuilt-paths';

/**
 * Logged, never thrown: a stale registry is answered by the scan, which imports what is on disk.
 * In an image it cannot happen — the registry is written after the source is copied in — so it
 * says the Dockerfile copies something after the prebuilt step.
 */
export class PrebuiltRegistryStaleError extends UltimateError {
  constructor(input: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    /** The same modules, and one at least was rewritten since the build (a background boot's check). */
    readonly changed?: boolean;
  }) {
    const first = [...input.added, ...input.removed].slice(0, 3).join(', ');
    const what = input.changed
      ? 'lists the modules on disk, and one or more of them changed content since it was written (which of them reach a component decides what a worker imports)'
      : `lists ${String(input.removed.length)} module(s) not on disk and misses ${String(input.added.length)} that are (${first})`;
    super({
      code: 'X_PREBUILT_REGISTRY_STALE',
      cause: `the prebuilt module registry ${what}, so this boot scanned the app instead of importing the registry`,
      fix: `edit docker/Dockerfile: move RUN ${PREBUILT_COMMAND} after the last COPY in the runtime stage, then rebuild the image`,
      meta: { added: input.added, removed: input.removed, changed: input.changed === true },
    });
  }
}

/** The module list `files` against the one on disk, as what each lacks. */
function difference(
  listed: readonly string[],
  onDisk: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const held = new Set(listed);
  const present = new Set(onDisk);
  return {
    added: onDisk.filter((file) => !held.has(file)),
    removed: listed.filter((file) => !present.has(file)),
  };
}

/**
 * Every chunk imported in order, each module reported to `receive` as it evaluates — or `false`
 * when one would not import, or another load held the hooks' slot.
 */
async function importChunks(
  dir: string,
  chunks: readonly string[],
  receive: OnEvaluated,
): Promise<boolean> {
  const imported = await receiving(receive, async () => {
    for (const chunk of chunks) {
      try {
        await import(join(dir, chunk));
      } catch {
        // The scan imports module by module and reports the one that fails, with its own cause.
        return false;
      }
    }
    return true;
  });
  return imported === true;
}

/** Logs the registry stale and answers `undefined`: the caller scans. */
function stale(input: ConstructorParameters<typeof PrebuiltRegistryStaleError>[0]): undefined {
  const error = new PrebuiltRegistryStaleError(input);
  logger.warn(error.format(), { code: error.code, ...error.meta });
  return undefined;
}

/**
 * The app, imported from the prebuilt registry and registered in its order — every module for a
 * role that imports `everything`, the background subset for `worker` and `scheduler` — or
 * `undefined`: no registry, one this Bun did not write, one whose module list is not the disk's
 * (logged, `X_PREBUILT_REGISTRY_STALE`), or a chunk that would not import. The list is checked
 * against the scan's own glob, which reads directory entries and imports nothing: a module added
 * after the build is a route or an action the registry would silently not serve. A background
 * boot also checks every module's stamp: its subset is decided by what the modules import.
 */
export async function loadPrebuiltApp(
  root: string,
  load: RoleLoad = 'everything',
): Promise<AppScan | undefined> {
  const registry = await readPrebuiltRegistry(root);
  if (registry === undefined) return undefined;
  const scanned = await scannedModulePaths(root);
  const onDisk = scanned.map((absolute) => posixRelative(root, absolute));
  if (onDisk.join('\n') !== registry.files.join('\n')) {
    return stale(difference(registry.files, onDisk));
  }
  if (load === 'background') {
    const stamp = await moduleStamp(root, registry.files);
    if (stamp !== registry.background.stamp)
      return stale({ added: [], removed: [], changed: true });
  }
  // The glob's own spelling of each path: registration is keyed by it, and a later full load (the
  // background boot's fallback) must find these modules registered under the same key.
  const absoluteOf = new Map(onDisk.map((file, index) => [file, scanned[index] as string]));
  const set = load === 'background' ? registry.background : registry;
  const absolutes = set.files.map((file) => absoluteOf.get(file));
  if (absolutes.some((absolute) => absolute === undefined)) return undefined;
  return importRegistered(root, set, absolutes as string[]);
}

/** `set`'s chunks imported and each module registered as it evaluates, in the set's order. */
async function importRegistered(
  root: string,
  set: RegistryChunks,
  absolutes: readonly string[],
): Promise<AppScan | undefined> {
  prepareAppImport(root);
  // Registered as each module evaluates, by its hook: a later module reads every earlier one
  // registered, as the scan leaves them (`app-load-batch.ts`).
  const findings: (Finding | undefined)[] = [];
  let evaluated = 0;
  const register: OnEvaluated = (index, module) => {
    const absolute = absolutes[index];
    if (absolute === undefined) return;
    evaluated += 1;
    const at = { absolute, file: set.files[index] as string, track: false };
    findings[index] = registerModule(module, at);
  };
  const imported = await importChunks(registryDir(root), set.chunks, register);
  if (!imported || evaluated !== absolutes.length) return undefined;
  return {
    files: [...set.files].sort(),
    findings: findings.filter((finding): finding is Finding => finding !== undefined),
  };
}
