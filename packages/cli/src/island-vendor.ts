// Solid as ONE output beside the islands: `vendor-solid.<contentHash>.js`, re-exporting `solid-js`,
// `solid-js/web` and `solid-js/store` whole, once per `buildIslands` call. Every island resolves
// them to it as an external, so three islands built apart download one Solid. Its bytes move with
// a Solid install, never an island edit, so no island's change re-names the file the rest import.

// why: Bun ships no path API; the vendor's URL is basePath joined to its file name.
import { posix } from 'node:path';
import { contentHash } from '@ultimat3/render/server';
import type { BunPlugin } from 'bun';
import { IslandBuildFailedError } from './errors';
import type { IslandChunk, SharedChunk } from './island-bundle';
import { inputFiles } from './island-cache-inputs';
import { describeBuildError, stableChunk, stripDebugId } from './island-identity';
import { frameworkDedupePlugins } from './island-package-dedupe';
import { solidDedupePlugin } from './island-solid-dedupe';

/**
 * The specifiers the vendor answers. `solid-js/h`, `/html` and `/universal` stay bundled into the
 * island that asks: rare, and each imports `solid-js/web`, which then resolves here.
 */
export const VENDOR_SPECIFIER = /^solid-js(?:\/web|\/store)?$/;

/**
 * The vendor entry. `DEV` is exported by both `solid-js` and `solid-js/store`, and two star
 * exports of one name export NEITHER (measured on 1.9.17: 121 names, `DEV` missing) — an island
 * importing it would fail to link in the browser. The explicit export wins over both stars; under
 * the production condition both are `undefined`.
 */
const VENDOR_SOURCE = [
  `export * from 'solid-js';`,
  `export * from 'solid-js/web';`,
  `export * from 'solid-js/store';`,
  `export { DEV } from 'solid-js';`,
  '',
].join('\n');

const ENTRY = 'ultimate:vendor-solid';
const NAMESPACE = 'ultimate-vendor-solid';

/**
 * `vendor-solid.<identity>.js` — the dot, as `page-runtime.<identity>.js` has it: a module id is
 * `[a-z0-9-]` only, so no island entry (`<moduleId>-<identity>.js`) can be served at this name.
 */
const VENDOR_FILE = /^vendor-solid\.[0-9a-z]+\.js$/;

/** Whether `url` (any base path) is the Solid vendor chunk — the one predicate, never a prefix. */
export function isVendorChunk(url: string): boolean {
  return VENDOR_FILE.test(posix.basename(url));
}

export interface VendorChunk {
  readonly url: string;
  /** `./vendor-solid.<identity>.js`: what an island's code imports, resolved beside it. */
  readonly specifier: string;
  readonly code: string;
  readonly bytes: number;
  /** Every file the vendor's build read, absolute (`inputFiles`): what a cached group rehashes. */
  readonly inputs: readonly string[];
}

/** The vendor a build's islands import — built at most once per `buildIslands` call. */
export type Vendors = () => Promise<VendorChunk>;

export function vendorBuilder(root: string, basePath: string): Vendors {
  let built: Promise<VendorChunk> | undefined;
  return () => {
    built ??= buildVendor(root, basePath);
    return built;
  };
}

async function buildVendor(root: string, basePath: string): Promise<VendorChunk> {
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [ENTRY],
      root,
      target: 'browser',
      format: 'esm',
      minify: true,
      // The app's one Solid copy (`island-solid-dedupe.ts`) — the copy every island was built
      // against before this file existed — under `island-bundle.ts`'s production `define`.
      plugins: [vendorEntryPlugin(), solidDedupePlugin(root), ...frameworkDedupePlugins(root)],
      define: { 'process.env.NODE_ENV': '"production"' },
      metafile: true,
    });
  } catch (error) {
    throw new IslandBuildFailedError({ file: 'solid-js', logs: describeBuildError(error) });
  }
  const output = built.outputs.find((artifact) => artifact.kind === 'entry-point');
  if (!built.success || output === undefined) {
    throw new IslandBuildFailedError({
      file: 'solid-js',
      logs: built.logs.map((log) => String(log)).join('; '),
    });
  }
  // Named by its bytes (#1075), as every island output is: `immutable` is a promise about them.
  const code = stripDebugId(await output.text());
  const identity = contentHash(code);
  const name = `vendor-solid.${identity}.js`;
  const url = `${basePath}/${name}`;
  return {
    url,
    specifier: `./${name}`,
    ...stableChunk(url, identity, code),
    inputs: await inputFiles(Object.keys(built.metafile?.inputs ?? {})),
  };
}

function vendorEntryPlugin(): BunPlugin {
  return {
    name: 'ultimate-vendor-solid-entry',
    setup(build) {
      build.onResolve({ filter: /^ultimate:vendor-solid$/ }, () => ({
        path: 'entry',
        namespace: NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, () => ({
        contents: VENDOR_SOURCE,
        loader: 'js',
      }));
    },
  };
}

/**
 * The island-side half: every vendored specifier, from any file of the island's graph, is the
 * vendor's relative URL, left external. Installed FIRST, ahead of the Solid dedupe, so no Solid
 * file is ever read into an island chunk.
 */
export function vendorExternalPlugin(vendor: VendorChunk): BunPlugin {
  return {
    name: 'ultimate-vendor-solid-external',
    setup(build) {
      build.onResolve({ filter: VENDOR_SPECIFIER }, () => ({
        path: vendor.specifier,
        external: true,
      }));
    },
  };
}

/** Whether `code` imports the vendor — statically or by `import()`. */
function importsVendor(code: string, vendor: VendorChunk): boolean {
  return new Bun.Transpiler({ loader: 'js' })
    .scan(code)
    .imports.some((one) => one.path === vendor.specifier);
}

/**
 * Every entry whose own code or a shared chunk it loads imports the vendor names it among its
 * `imports`, so a precache, a preload and a budget count it — once, by URL.
 */
export function loadingVendor(
  chunks: readonly IslandChunk[],
  shared: readonly SharedChunk[],
  vendor: VendorChunk | undefined,
): readonly IslandChunk[] {
  if (vendor === undefined) return chunks;
  const sharedLoads = new Set(
    shared.filter((one) => importsVendor(one.code, vendor)).map((one) => one.url),
  );
  return chunks.map((chunk) =>
    importsVendor(chunk.code, vendor) || chunk.imports.some((url) => sharedLoads.has(url))
      ? { ...chunk, imports: [...new Set([...chunk.imports, vendor.url])].sort() }
      : chunk,
  );
}

/** The vendor as the bundle's shared asset, with the islands that load it; none, no asset. */
export function vendorShared(
  vendor: VendorChunk | undefined,
  chunks: readonly IslandChunk[],
): readonly SharedChunk[] {
  if (vendor === undefined) return [];
  const importers = chunks
    .filter((chunk) => chunk.imports.includes(vendor.url))
    .map((chunk) => chunk.file)
    .sort();
  if (importers.length === 0) return [];
  const { url, code, bytes } = vendor;
  return [{ url, code, bytes, importers, sources: [] }];
}
