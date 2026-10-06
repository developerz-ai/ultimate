// Realtime installed for the author, on exactly the islands that use it: an island whose own import
// graph reaches `@ultimat3/realtime` is built from a virtual entry that first awaits the page
// runtime (`island-runtime.ts`), then calls `installRealtime({ signal: createSignal })` with THIS
// bundle's solid-js, then re-exports the island whole. Every other island pays nothing.

// why: Bun ships no path API; the entry is joined to the root, the runtime named by its basename.
import { basename, join } from 'node:path';
import type { BunPlugin } from 'bun';
import { RUNTIME_CHUNK_SPECIFIER, type RuntimeChunk } from './island-runtime';
import { firstInGraph } from './live-routes';
import { PAGE_BOOT_BASE_PATH } from './worker-bundle';

/**
 * What `Bun.build` is handed for a realtime island: this prefix plus the island's app-root-relative
 * path, so ONE build can carry every realtime island's wrapper as its own entry point. Resolved by
 * `islandRealtimePlugin`, and the prefix is what `island-bundle.ts` strips back off Bun's output path.
 */
export const REALTIME_ISLAND_ENTRY = 'ultimate:island-entry:';

/** The entry point `Bun.build` is handed for a realtime island. */
export const realtimeIslandEntry = (file: string): string => `${REALTIME_ISLAND_ENTRY}${file}`;

const REALTIME = '@ultimat3/realtime';
const NAMESPACE = 'ultimate-island';
const INSTALL = 'ultimate:island-realtime';
const MODULE = 'ultimate:island-module:';
const WAIT = 'ultimate:island-page-wait';

/**
 * Whether the island's own graph value-imports realtime. Relative specifiers only, which is the
 * one blind spot: a PACKAGE importing realtime for the island is not seen, and a hook it calls
 * then throws `X_REALTIME_UNINSTALLED` by name — loud, never silent.
 */
export async function reachesRealtime(root: string, file: string): Promise<boolean> {
  const found = await firstInGraph(root, file, (source, path) => {
    // The transpiler, not a regex: it erases `import type` and reads a re-export as an import.
    const scanned = new Bun.Transpiler({ loader: path.endsWith('x') ? 'tsx' : 'ts' }).scanImports(
      source,
    );
    return scanned.some((entry) => entry.path === REALTIME) ? true : undefined;
  });
  // Recorded with the answer, so the document renderer can ask it of a page's islands without a
  // second graph walk per request. Every build re-asks, so an edit that drops realtime drops it.
  if (found === true) realtimeIslands.add(file);
  else realtimeIslands.delete(file);
  return found === true;
}

/** App-root-relative island files whose graph reaches realtime, as the last build answered. */
const realtimeIslands = new Set<string>();

/**
 * The islands (app-root-relative POSIX paths) the last build found reaching realtime. A page needs
 * realtime's page boot only if one of ITS islands does — `settings` paid 34.9 kB of boot script
 * for an island that never touched a record.
 */
export function realtimeIslandFiles(): ReadonlySet<string> {
  return realtimeIslands;
}

/**
 * `export *` and never a named list: the hydration runtime reads `mount` off the module, and the
 * wrapper must not decide which of an island's names survive. The install is imported FIRST, so it
 * has run before the island's module body — and every hook the island calls — does. One install
 * module for every realtime island of the build, so a page with two of them loads it once.
 */
const entrySource = (file: string): string =>
  `import '${INSTALL}';\nexport * from '${MODULE}${file}';\n`;

/**
 * The install names `@ultimat3/realtime` BARE, and `islandRealtimePlugin` resolves it from the
 * ISLAND's own directory — the resolution the island itself gets — so the bundle holds one copy
 * and the signal lands where the hooks read it. Never the resolved absolute path spliced in: this
 * source is part of the chunk's `sourcesContent`, which is what `graphHash` names the URL from, so
 * a path in it gave the same island a different URL in every checkout and every image build.
 * `solid-js` goes through `island-solid-dedupe.ts` like every other import in the graph.
 *
 * The await comes first: no hook may run before the page runtime is installed, and the module
 * graph is not done — so `mount` is not called — until it is. The page boot carries the runtime
 * on a document rendered for a principal; anywhere else the island loads the runtime chunk, by a
 * path relative to its own URL, so it resolves under `/islands/` and beside it in `mountIsland`.
 * The chunk's URL is in this source, so a new runtime is a new URL for every island loading it.
 * Then the first-paint hold (#506): `mount` waits for the restored records and the open outbox
 * (capped), so a reload's first render already carries a queued write's overlay.
 */
const installSource = (runtimeUrl: string): string =>
  `import { holdFirstPaint, installRealtime } from '${REALTIME}';\n` +
  `import { awaitPageRuntime } from '${WAIT}';\n` +
  `import { createSignal } from 'solid-js';\n` +
  `await awaitPageRuntime({ boot: '${PAGE_BOOT_BASE_PATH}/', load: () => import('./${basename(runtimeUrl)}') });\n` +
  `await holdFirstPaint();\n` +
  `installRealtime({ signal: createSignal });\n`;

/**
 * `runtime` names the realtime every bare `@ultimat3/realtime` of the build resolves to — the copy
 * the runtime chunk was built against, resolved from the first realtime island's directory. One
 * copy for all of them, because one copy in the bundle is the requirement: the signal the install
 * sets is only read by hooks from the same module instance, and the page object it reads is the
 * shape that copy's runtime installs.
 */
export function islandRealtimePlugin(root: string, runtime: RuntimeChunk): BunPlugin {
  return {
    name: 'ultimate-island-realtime',
    setup(build) {
      build.onResolve({ filter: /^ultimate:island-entry:/ }, (args) => ({
        path: `entry:${args.path.slice(REALTIME_ISLAND_ENTRY.length)}`,
        namespace: NAMESPACE,
      }));
      build.onResolve({ filter: /^ultimate:island-realtime$/ }, () => ({
        path: 'install',
        namespace: NAMESPACE,
      }));
      build.onResolve({ filter: /^ultimate:island-module:/ }, (args) => ({
        path: join(root, args.path.slice(MODULE.length)),
      }));
      // The wait is realtime's, from the copy the hooks are bundled from; the runtime chunk is
      // another file of this build's output, fetched by the browser and never bundled in.
      build.onResolve({ filter: /^ultimate:island-page-wait$/ }, () => ({ path: runtime.wait }));
      build.onResolve({ filter: RUNTIME_CHUNK_SPECIFIER }, (args) => ({
        path: args.path,
        external: true,
      }));
      // Every bare `@ultimat3/realtime` in this build, the virtual install's included — a virtual
      // module has no directory to resolve from. The island's directory for all of them, which is
      // what the island itself would get.
      build.onResolve({ filter: /^@ultimat3\/realtime$/ }, () => ({ path: runtime.realtime }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
        contents: args.path.startsWith('entry:')
          ? entrySource(args.path.slice('entry:'.length))
          : installSource(runtime.url),
        loader: 'js',
      }));
    },
  };
}
