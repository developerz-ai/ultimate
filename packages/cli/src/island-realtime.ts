// Realtime installed for the author, on exactly the islands that use it: an island whose own import
// graph reaches `@ultimat3/realtime` is built from a virtual entry that first calls
// `installRealtime({ signal: createSignal })` with THIS bundle's solid-js, then re-exports the
// island whole. Every other island is built from its own file and pays nothing (plan 101 slice 14).

// why: Bun ships no path API; the entry is joined to the root and resolved from its directory.
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';
import { firstInGraph } from './live-routes';

/** What `Bun.build` is handed for a realtime island; resolved by `islandRealtimePlugin`. */
export const REALTIME_ISLAND_ENTRY = 'ultimate:island-entry';

const REALTIME = '@ultimat3/realtime';
const NAMESPACE = 'ultimate-island';
const INSTALL = 'ultimate:island-realtime';
const MODULE = 'ultimate:island-module';

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
 * has run before the island's module body — and every hook the island calls — does.
 */
const ENTRY_SOURCE = `import '${INSTALL}';\nexport * from '${MODULE}';\n`;

/**
 * The install resolves `@ultimat3/realtime` from the ISLAND's own directory — the resolution the
 * island itself gets — so the bundle holds one copy and the signal lands where the hooks read it.
 * `solid-js` goes through `island-solid-dedupe.ts` like every other import in the graph.
 */
const INSTALL_SOURCE = (realtime: string): string =>
  `import { installRealtime } from ${JSON.stringify(realtime)};\n` +
  `import { createSignal } from 'solid-js';\n` +
  `installRealtime({ signal: createSignal });\n`;

export function islandRealtimePlugin(root: string, file: string): BunPlugin {
  const island = join(root, file);
  return {
    name: 'ultimate-island-realtime',
    setup(build) {
      build.onResolve({ filter: /^ultimate:island-entry$/ }, () => ({
        path: 'entry',
        namespace: NAMESPACE,
      }));
      build.onResolve({ filter: /^ultimate:island-realtime$/ }, () => ({
        path: 'install',
        namespace: NAMESPACE,
      }));
      build.onResolve({ filter: /^ultimate:island-module$/ }, () => ({ path: island }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
        contents:
          args.path === 'entry'
            ? ENTRY_SOURCE
            : INSTALL_SOURCE(Bun.resolveSync(REALTIME, dirname(island))),
        loader: 'js',
      }));
    },
  };
}
