// The app's prebuilt module registry: every module the scan imports, in scan order, written by
// `x build --target prebuilt` as the scan's own batches (`batchSources`), and read by a serving
// role's boot instead of a scan (`app-load-prebuilt.ts`). A leaf of the boot graph: it writes and
// reads files and imports none of the app.

// why: Bun ships no recursive remove; a previous registry must not survive beside the new one.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; a chunk names each module relative to itself.
import { join, relative } from 'node:path';
import { isJsonObject } from '@ultimat3/core';
import type { AppScan } from './app-load';
import { scannedModulePaths } from './app-load';
import { asyncModules } from './app-load-async';
import { batchSources, planBatches, uniqueBatchName } from './app-load-batch';
import { toPosix } from './posix-path';
import { PREBUILT_REGISTRY_DIR } from './serve-prebuilt-paths';

/**
 * Bumped whenever the shape below changes: a registry of another format is not read. 2: a chunk
 * imports a hook module per app module, which registers it before the next one evaluates.
 */
export const REGISTRY_FORMAT = 2;

const INDEX_FILE = 'registry.json';

/** `registry.json`: what the chunks import, and what wrote them. */
export interface PrebuiltRegistry {
  readonly format: typeof REGISTRY_FORMAT;
  /** The Bun that wrote it: a chunk is evaluated by the runtime that resolved its specifiers. */
  readonly bun: string;
  /** App-root-relative POSIX paths, in scan order — the order the chunks import them in. */
  readonly files: readonly string[];
  /**
   * Registry-dir-relative chunk files, in order, holding `files` in order between them: up to
   * `BATCH_SIZE` each, and a module whose evaluation can suspend in a chunk of its own. Each
   * imports the hook modules (`hookFile`) beside it, one per app module.
   */
  readonly chunks: readonly string[];
}

/** The registry's directory under `root`. */
export const registryDir = (root: string): string => join(root, PREBUILT_REGISTRY_DIR);

/**
 * A chunk's specifier for one module: relative to the chunk, so a registry written at one
 * `WORKDIR` resolves at another — the image is the same tree wherever it is mounted.
 */
function specifierFor(dir: string, absolute: string): string {
  const path = toPosix(relative(dir, absolute));
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * Writes the registry for `modules` (absolute paths, scan order) and answers it. Every earlier
 * registry is removed first: a chunk left from a larger app would import a module that is gone.
 */
export async function writePrebuiltRegistry(
  root: string,
  modules: readonly string[],
): Promise<PrebuiltRegistry> {
  await rm(registryDir(root), { recursive: true, force: true });
  // Under a directory of this write's own: a process that writes a registry twice and boots from
  // it (a test, `x build` beside `x serve`) would otherwise import the first write's cached hooks.
  const own = uniqueBatchName();
  const dir = join(registryDir(root), own);
  const chunks: string[] = [];
  // Cut as the scan cuts: a module that awaits at its top level, or reaches one, is alone.
  let first = 0;
  for (const batch of planBatches(modules, await asyncModules(root, modules))) {
    const name = `chunk-${String(chunks.length)}.ts`;
    const { entry, hooks } = batchSources(
      batch.map((path) => specifierFor(dir, path)),
      first,
    );
    await Promise.all(hooks.map(([hook, source]) => Bun.write(join(dir, hook), source)));
    await Bun.write(join(dir, name), entry);
    chunks.push(`${own}/${name}`);
    first += batch.length;
  }
  const registry: PrebuiltRegistry = {
    format: REGISTRY_FORMAT,
    bun: Bun.version,
    files: modules.map((path) => toPosix(relative(root, path))),
    chunks,
  };
  await Bun.write(join(registryDir(root), INDEX_FILE), `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')
    ? (value as string[])
    : undefined;

/**
 * The registry under `root`, or `undefined` when there is none this process can use: absent,
 * unreadable, of another format, or written by another Bun.
 */
export async function readPrebuiltRegistry(root: string): Promise<PrebuiltRegistry | undefined> {
  const parsed: unknown = await Bun.file(join(registryDir(root), INDEX_FILE))
    .json()
    .catch(() => undefined);
  if (!isJsonObject(parsed)) return undefined;
  const files = strings(parsed['files']);
  const chunks = strings(parsed['chunks']);
  if (parsed['format'] !== REGISTRY_FORMAT || parsed['bun'] !== Bun.version) return undefined;
  if (files === undefined || chunks === undefined) return undefined;
  // Every chunk holds one module at least; the boot checks the modules they hold add up to `files`.
  if (chunks.length > files.length || (files.length > 0 && chunks.length === 0)) return undefined;
  return { format: REGISTRY_FORMAT, bun: Bun.version, files, chunks };
}

/**
 * The image build's half: after its own scan of the app, the registry of what that scan imported —
 * or none, removing any earlier one, when a module would not import. A registry missing that
 * module would boot without its routes and actions; with none, the boot scans and refuses to serve
 * a half-loaded app (`X_APP_MODULE_LOAD_FAILED`), with the module's own cause.
 */
export async function prebuildRegistry(
  root: string,
  scan: AppScan,
): Promise<PrebuiltRegistry | undefined> {
  if (scan.findings.length === 0)
    return writePrebuiltRegistry(root, await scannedModulePaths(root));
  await rm(registryDir(root), { recursive: true, force: true });
  return undefined;
}
