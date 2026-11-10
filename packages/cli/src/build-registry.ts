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
import { backgroundModules } from './build-registry-background';
import { toPosix } from './posix-path';
import { PREBUILT_REGISTRY_DIR } from './serve-prebuilt-paths';

/**
 * Bumped whenever the shape below changes: a registry of another format is not read. 2: a chunk
 * imports a hook module per app module, which registers it before the next one evaluates. 3: a
 * second chunk set, the background roles' (`background`), and the stamp it is trusted under.
 */
export const REGISTRY_FORMAT = 3;

const INDEX_FILE = 'registry.json';

/** The background chunks' directory, beside the full set's: their hook files share names. */
const BACKGROUND_DIR = 'background';

/** One ordered module list and the chunks that import it. */
export interface RegistryChunks {
  /** App-root-relative POSIX paths, in scan order — the order the chunks import them in. */
  readonly files: readonly string[];
  /**
   * Registry-dir-relative chunk files, in order, holding `files` in order between them: up to
   * `BATCH_SIZE` each, and a module whose evaluation can suspend in a chunk of its own. Each
   * imports the hook modules (`hookFile`) beside it, one per app module.
   */
  readonly chunks: readonly string[];
}

/** `registry.json`: what the chunks import, and what wrote them. */
export interface PrebuiltRegistry extends RegistryChunks {
  readonly format: typeof REGISTRY_FORMAT;
  /** The Bun that wrote it: a chunk is evaluated by the runtime that resolved its specifiers. */
  readonly bun: string;
  /**
   * What `worker` and `scheduler` import (`build-registry-background.ts`), a subsequence of
   * `files`. `stamp` is `moduleStamp` (the bytes) of every module at write time: which modules
   * reach a document is a fact about their content, so a module edited since is answered by the
   * scan.
   */
  readonly background: RegistryChunks & { readonly stamp: string };
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

/** Reads at most this many modules at once: a 12k-module app opened 12k descriptors otherwise. */
const STAMP_BATCH = 64;

/** One module's bytes, hashed — or `absent` for a file that cannot be read. */
const contentHash = (path: string): Promise<string> =>
  Bun.file(path)
    .bytes()
    .then(
      (bytes) => Bun.hash(bytes).toString(16),
      () => 'absent',
    );

/**
 * The bytes of every module of `files` (app-root-relative), hashed, path by path. Never a
 * modification time: an image build that rewrites timestamps (BuildKit `rewrite-timestamp`, a
 * stage that copies the app again) moves every one and changes no module, and a stamp built on
 * them sent every worker boot to the scan. Measured on 5,101 modules (2026-11-10): 30–73 ms,
 * median 51, against a 1.5 s boot.
 */
export async function moduleStamp(root: string, files: readonly string[]): Promise<string> {
  const facts: string[] = [];
  for (let start = 0; start < files.length; start += STAMP_BATCH) {
    const batch = files.slice(start, start + STAMP_BATCH);
    const hashes = await Promise.all(batch.map((file) => contentHash(join(root, file))));
    for (const [index, file] of batch.entries()) facts.push(`${file}\0${hashes[index] ?? ''}`);
  }
  return Bun.hash(facts.join('\n')).toString(16);
}

/** Writes the chunks importing `modules` (absolute, scan order) under `registryDir/<prefix>`. */
async function writeChunks(
  root: string,
  prefix: string,
  modules: readonly string[],
  alone: ReadonlySet<string>,
): Promise<RegistryChunks> {
  const dir = join(registryDir(root), prefix);
  const chunks: string[] = [];
  // Cut as the scan cuts: a module that awaits at its top level, or reaches one, is alone.
  let first = 0;
  for (const batch of planBatches(modules, alone)) {
    const name = `chunk-${String(chunks.length)}.ts`;
    const { entry, hooks } = batchSources(
      batch.map((path) => specifierFor(dir, path)),
      first,
    );
    await Promise.all(hooks.map(([hook, source]) => Bun.write(join(dir, hook), source)));
    await Bun.write(join(dir, name), entry);
    chunks.push(`${prefix}/${name}`);
    first += batch.length;
  }
  return { files: modules.map((path) => toPosix(relative(root, path))), chunks };
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
  const alone = await asyncModules(root, modules);
  const everything = await writeChunks(root, own, modules, alone);
  const background = await writeChunks(
    root,
    `${own}/${BACKGROUND_DIR}`,
    await backgroundModules(root, modules),
    alone,
  );
  const registry: PrebuiltRegistry = {
    format: REGISTRY_FORMAT,
    bun: Bun.version,
    ...everything,
    background: { ...background, stamp: await moduleStamp(root, everything.files) },
  };
  await Bun.write(join(registryDir(root), INDEX_FILE), `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')
    ? (value as string[])
    : undefined;

/** One chunk set as read, or `undefined` when it cannot hold its files in order. */
function chunksOf(value: unknown): RegistryChunks | undefined {
  if (!isJsonObject(value)) return undefined;
  const files = strings(value['files']);
  const chunks = strings(value['chunks']);
  if (files === undefined || chunks === undefined) return undefined;
  // Every chunk holds one module at least; the boot checks the modules they hold add up to `files`.
  if (chunks.length > files.length || (files.length > 0 && chunks.length === 0)) return undefined;
  return { files, chunks };
}

/**
 * The registry under `root`, or `undefined` when there is none this process can use: absent,
 * unreadable, of another format, or written by another Bun.
 */
export async function readPrebuiltRegistry(root: string): Promise<PrebuiltRegistry | undefined> {
  const parsed: unknown = await Bun.file(join(registryDir(root), INDEX_FILE))
    .json()
    .catch(() => undefined);
  if (!isJsonObject(parsed)) return undefined;
  if (parsed['format'] !== REGISTRY_FORMAT || parsed['bun'] !== Bun.version) return undefined;
  const everything = chunksOf(parsed);
  const background = chunksOf(parsed['background']);
  const stamp = isJsonObject(parsed['background']) ? parsed['background']['stamp'] : undefined;
  if (everything === undefined || background === undefined || typeof stamp !== 'string') {
    return undefined;
  }
  return {
    format: REGISTRY_FORMAT,
    bun: Bun.version,
    ...everything,
    background: { ...background, stamp },
  };
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
