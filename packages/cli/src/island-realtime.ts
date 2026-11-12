// Realtime installed for the author, on exactly the islands that use it: an island whose own import
// graph reaches `@ultimat3/realtime` is built from a virtual entry that first awaits the page
// runtime (`island-runtime.ts`), then calls `installRealtime({ signal, cleanup })` with THIS
// bundle's solid-js, then re-exports the island whole. Every other island pays nothing. An island
// that reads the record store or the outbox also waits for the page's restore before it mounts
// (#506); one that only follows the socket does not (`island-realtime-state.ts`).

// why: Bun ships no path API; the entry is joined to the root, the runtime named by its basename,
// core's transport found beside the core module importing it.
import { basename, dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';
import { followsOnly, type IslandRealtime } from './island-realtime-state';
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
const RESTORE = 'ultimate:island-restore';
const MODULE = 'ultimate:island-module:';
const WAIT = 'ultimate:island-page-wait';
const CORE_TRANSPORT = 'ultimate:island-core-transport';
/** What core's own modules import the transport by — the one specifier the swap answers. */
const TRANSPORT_SPECIFIER = /^\.\/client-transport$/;
const TRANSPORT_MODULE = 'transport:';

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
  return found === true;
}

/**
 * Both of a build's answers about one island, for its chunk to carry (`IslandChunk.realtime`):
 * `undefined` when its graph never reaches realtime. A page needs realtime's page boot only if one
 * of ITS islands does — `settings` paid 34.9 kB of boot script for an island that never touched a
 * record — and holds only the ones that restore. `persists` is REQUIRED, and the build passes the
 * loaded app's registry's answer (`appPersistsRecords`): every boot that builds islands has imported
 * the app first. As a default it read process-wide state here, so one test's entities changed
 * another's answer (`bun test ./packages/cli`, alone, went red); `undefined` is "unknown".
 */
export async function realtimeKind(
  root: string,
  file: string,
  persists: boolean | undefined,
): Promise<IslandRealtime | undefined> {
  if (!(await reachesRealtime(root, file))) return undefined;
  return (await followsOnly(root, file, persists)) ? 'follows' : 'restores';
}

/**
 * `export *` and never a named list: the hydration runtime reads `mount` off the module, and the
 * wrapper must not decide which of an island's names survive. The install is imported FIRST, so it
 * has run before the island's module body — and every hook the island calls — does. One install
 * module for every realtime island of the build, so a page with two of them loads it once; an
 * island with page state to restore imports the restore, which imports that same install.
 */
const entrySource = (file: string, follows: boolean): string =>
  `import '${follows ? INSTALL : RESTORE}';\n` + `export * from '${MODULE}${file}';\n`;

/**
 * The install names `@ultimat3/realtime` BARE, and `islandRealtimePlugin` resolves it from the
 * ISLAND's own directory — the resolution the island itself gets — so the bundle holds one copy
 * and the signal lands where the hooks read it.
 * `solid-js` goes through `island-solid-dedupe.ts` like every other import in the graph.
 *
 * The await comes first: no hook may run before the page runtime is installed, and the module
 * graph is not done — so `mount` is not called — until it is. The page boot carries the runtime
 * on a document rendered for a principal; anywhere else the island loads the runtime chunk, by a
 * path relative to its own URL, so it resolves under `/islands/` and beside it in `mountIsland`.
 * The chunk's URL is in this source, so a new runtime is a new URL for every island loading it.
 *
 * `cleanup` is Solid's `onCleanup`, so every hook a component holds is released with it — the
 * island author writes no `onCleanup(() => h.release())`. A hook held outside a component (module
 * scope, an event handler) has no owner, so Solid registers nothing and it stays the caller's: an
 * island is built against solid's production build (`island-solid-dedupe.ts`), which is silent
 * there.
 */
const installSource = (runtimeUrl: string): string =>
  `import { installRealtime } from '${REALTIME}';\n` +
  `import { awaitPageRuntime } from '${WAIT}';\n` +
  `import { createSignal, onCleanup } from 'solid-js';\n` +
  `await awaitPageRuntime({ boot: '${PAGE_BOOT_BASE_PATH}/', load: () => import('./${basename(runtimeUrl)}') });\n` +
  `installRealtime({ signal: createSignal, cleanup: onCleanup });\n`;

/**
 * The first-paint hold (#506), for an island that reads the record store or the outbox: `mount`
 * waits for the restored records and the open outbox (capped), so a reload's first render already
 * carries a queued write's overlay. After the install, which it imports: the wait needs the page
 * runtime, and no hook runs before the island's module graph — this module included — is done.
 * An island that only follows the socket never imports it, so it mounts as soon as the runtime is
 * there and its chunk carries no `first-paint-hold.ts`.
 */
const restoreSource = (): string =>
  `import '${INSTALL}';\n` +
  `import { holdFirstPaint } from '${REALTIME}';\n` +
  `await holdFirstPaint();\n`;

/**
 * Core's `client-transport.ts`, as a realtime island's bundle sees it: `clientTransport` sends
 * through the page runtime's copy (`runtimeSend`), and `settleAnswer` — `clientStream`'s, which
 * the runtime does not expose — is the real one, tree-shaken to what it needs. The island awaited
 * the runtime before its module body ran, so a send can never find it absent. Measured on
 * `examples/dummy`'s run console, As of 2026-11-07: see `island-transport.test.ts`'s header.
 */
const transportSource = (): string =>
  `import { runtimeSend } from '${WAIT}';\n` +
  `export { settleAnswer } from '${CORE_TRANSPORT}';\n` +
  `export function clientTransport(req) {\n  return runtimeSend(req);\n}\n`;

/** Whether `file` is a source file of an installed `@ultimat3/core` — any copy of it. */
async function inCore(file: string, cache: Map<string, Promise<boolean>>): Promise<boolean> {
  const dir = dirname(file);
  let known = cache.get(dir);
  if (known === undefined) {
    known = packageNameAbove(dir).then((name) => name === '@ultimat3/core');
    cache.set(dir, known);
  }
  return await known;
}

async function packageNameAbove(start: string): Promise<string | undefined> {
  for (let dir = start; dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = Bun.file(join(dir, 'package.json'));
    if (!(await manifest.exists())) continue;
    const parsed: unknown = await manifest.json();
    const name =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'name') : undefined;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

/**
 * `runtime` names the realtime every bare `@ultimat3/realtime` of the build resolves to — the copy
 * the runtime chunk was built against, resolved from the first realtime island's directory. One
 * copy for all of them, because one copy in the bundle is the requirement: the signal the install
 * sets is only read by hooks from the same module instance, and the page object it reads is the
 * shape that copy's runtime installs. `follows` is THIS build's islands that restore nothing: an
 * island absent from it waits for the restore, which is the answer that can never paint stale.
 *
 * `sendThroughRuntime` swaps core's transport for the runtime's (`transportSource`). Only for a
 * build whose every entry is a realtime island: one split build shares a module between its
 * entries, and a plain island never waits for a runtime to send through.
 */
export function islandRealtimePlugin(
  root: string,
  runtime: RuntimeChunk,
  follows: ReadonlySet<string> = new Set(),
  sendThroughRuntime = false,
): BunPlugin {
  const cores = new Map<string, Promise<boolean>>();
  return {
    name: 'ultimate-island-realtime',
    setup(build) {
      if (sendThroughRuntime) {
        // Only core's own `./client-transport` — an app file of that name is the app's. The real
        // file rides in the namespace path, so the module's SOURCE names no path on this machine.
        build.onResolve({ filter: TRANSPORT_SPECIFIER }, async (args) =>
          args.namespace === 'file' && (await inCore(args.importer, cores))
            ? {
                path: `${TRANSPORT_MODULE}${join(dirname(args.importer), 'client-transport.ts')}`,
                namespace: NAMESPACE,
              }
            : undefined,
        );
        build.onResolve({ filter: /^ultimate:island-core-transport$/ }, (args) => ({
          path: args.importer.slice(TRANSPORT_MODULE.length),
        }));
      }
      build.onResolve({ filter: /^ultimate:island-entry:/ }, (args) => ({
        path: `entry:${args.path.slice(REALTIME_ISLAND_ENTRY.length)}`,
        namespace: NAMESPACE,
      }));
      build.onResolve({ filter: /^ultimate:island-realtime$/ }, () => ({
        path: 'install',
        namespace: NAMESPACE,
      }));
      build.onResolve({ filter: /^ultimate:island-restore$/ }, () => ({
        path: 'restore',
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
          ? entrySource(
              args.path.slice('entry:'.length),
              follows.has(args.path.slice('entry:'.length)),
            )
          : args.path === 'restore'
            ? restoreSource()
            : args.path.startsWith(TRANSPORT_MODULE)
              ? transportSource()
              : installSource(runtime.url),
        loader: 'js',
      }));
    },
  };
}
