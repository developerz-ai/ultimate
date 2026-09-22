// One question only this package can ask: a route SUBSCRIBES to live rows, and does anything on
// that route ever run in a browser to receive them? `@ultimat3/realtime` cannot see a route and
// `@ultimat3/render` may not import realtime, so the two halves meet here — beside the island
// build, which is the other place the route table and the client graph are both in scope.
//
// The failure it closes is silent by construction (#271): with no island the page server-renders
// its `loading` branch, answers 200, and stays that way forever — nothing throws, nothing logs,
// and every suite passes.

// why: Bun exposes no path API, and a route file's imports are resolved against its own directory.
import { join, posix } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { RouteEntry } from '@ultimat3/render';
import { ISLAND_EXTENSION, routeEntries } from '@ultimat3/render';
import { discoverIslands } from './island-bundle';
import type { Finding } from './output';

/**
 * The exports that only work in a booted browser page: each one reads the page's store, its socket
 * or its connection, so a module naming one needs an island to have run it. `hasPageSocket` is
 * deliberately absent — it IS the guard — and so is `installRealtime`, which the island bundle
 * writes for the author (plan 101, slice 14).
 */
export const LIVE_HOOKS = [
  'useQuery',
  'useConnection',
  'useMutation',
  'useMutationQueue',
  'useRecord',
  'useChannel',
] as const;

/**
 * NOT an escape hatch, `As of 2026-09-22`: `hasPageSocket()` answers false on the server, every
 * time, so a module that guards on it and never runs in a browser renders nothing forever. It was
 * exempted here — "a module that asks has handled the absence" — and that is exactly how
 * `examples/dummy`'s update banner, in a layout no island imports, never showed "A new version is
 * ready.". It is a browser-only read like any hook, so it is reported like one.
 */
const GUARD = 'hasPageSocket';

/** Everything that only means something in a booted browser page: the hooks, and the guard. */
const BROWSER_ONLY: readonly string[] = [GUARD, ...LIVE_HOOKS];

/** Value imports only: `import type` is erased, so it boots nothing and needs nothing. */
const REALTIME_IMPORT = /import\s+([^;]*?)from\s*['"]@ultimat3\/realtime(?:\/[\w-]+)?['"]/g;

const bindingsOf = (clause: string): readonly string[] =>
  (/\{([^}]*)\}/.exec(clause)?.[1] ?? '')
    .split(',')
    .map((entry) => entry.split(/\bas\b/)[0]?.trim() ?? '')
    .filter((name) => name.length > 0 && !name.startsWith('type '));

/** Which browser-only reads one module imports — the hooks and `hasPageSocket` — or `[]`. */
export function liveHooksIn(source: string): readonly string[] {
  const hooks: string[] = [];
  for (const match of source.matchAll(REALTIME_IMPORT)) {
    const clause = match[1] ?? '';
    if (clause.trimStart().startsWith('type ')) continue;
    const names = bindingsOf(clause);
    for (const hook of BROWSER_ONLY) if (names.includes(hook)) hooks.push(hook);
  }
  return hooks;
}

/** What a relative specifier can be on disk. The list `fix-imports.ts` already resolves against. */
const candidates = (base: string): readonly string[] => [
  `${base}.ts`,
  `${base}.tsx`,
  `${base}/index.ts`,
  `${base}/index.tsx`,
];

async function readModule(
  root: string,
  file: string,
): Promise<{ path: string; source: string } | undefined> {
  for (const path of file.endsWith('.ts') || file.endsWith('.tsx') ? [file] : candidates(file)) {
    const handle = Bun.file(join(root, path));
    if (await handle.exists()) return { path, source: await handle.text() };
  }
  return undefined;
}

/** Where a route's graph first reaches a live hook. */
export interface LiveReach {
  /** App-root-relative module that imports it. */
  readonly at: string;
  readonly hook: string;
}

/**
 * Walk a module's own import graph and answer the first thing `probe` finds in it.
 *
 * Relative specifiers only. A bare one resolves through `node_modules` or a workspace name, and
 * following either would mean guessing which package a name came from — the limit `fix-imports.ts`
 * records for the same walk. So this UNDER-reports rather than over-reports: a finding here is
 * always a real one, which is what lets the rule ship with no pin table.
 */
export async function firstInGraph<T>(
  root: string,
  file: string,
  probe: (source: string, path: string) => T | undefined,
): Promise<T | undefined> {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    const module = await readModule(root, next);
    if (module === undefined) continue;
    const found = probe(module.source, module.path);
    if (found !== undefined) return found;
    const loader = module.path.endsWith('x') ? 'tsx' : 'ts';
    // Bun's transpiler is the parser, exactly as in `scripts/boundaries.ts`: it erases type-only
    // imports and finds the dynamic ones, which no regex over this source could do.
    for (const scanned of new Bun.Transpiler({ loader }).scanImports(module.source)) {
      if (!scanned.path.startsWith('.')) continue;
      queue.push(posix.normalize(posix.join(posix.dirname(module.path), scanned.path)));
    }
  }
  return undefined;
}

/** Every module in a file's relative import graph, app-root-relative — one walk, no probe. */
export async function graphModules(root: string, file: string): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  await firstInGraph(root, file, (_source, path) => {
    seen.add(path);
    return undefined;
  });
  return seen;
}

/** Every module a browser can run: the union of every island's graph in the app. */
async function islandModules(root: string): Promise<ReadonlySet<string>> {
  const modules = new Set<string>();
  for (const island of await discoverIslands(root)) {
    for (const path of await graphModules(root, island)) modules.add(path);
  }
  return modules;
}

/** Each module in the route's graph that reads a browser-only name, with the first name it reads. */
async function browserOnlyReads(root: string, file: string): Promise<readonly LiveReach[]> {
  const reads: LiveReach[] = [];
  await firstInGraph(root, file, (source, path) => {
    const hook = liveHooksIn(source)[0];
    if (hook !== undefined) reads.push({ at: path, hook });
    return undefined;
  });
  return reads;
}

export interface LiveRouteGap extends LiveReach {
  readonly route: string;
  readonly file: string;
  /** What the route declares. `'never'` is the second way nothing boots. */
  readonly hydrate: string;
  readonly islands: readonly string[];
}

/** The `x g island` invocation that fixes it, built from this route's own file — never a placeholder. */
const generatorFor = (file: string): string => {
  const dir = posix.dirname(file);
  return `x g island ${posix.basename(dir)} --at ${dir}`;
};

/**
 * Every browser-only read a route's SERVER graph holds that no browser will ever run. A page's
 * imports are server-rendered — an island is reached by a `src` string, never an import — so a
 * module there runs in a browser only if some island's own graph imports it too. Anything else
 * renders its server state (nothing, or `loading`) forever, at 200. `hydrate: 'never'` boots no
 * island at all, so every read on such a route is reported. One finding per MODULE: a layout every
 * page imports is one mistake, not one per route.
 */
export async function liveRouteGaps(
  root: string,
  entries: readonly RouteEntry[],
): Promise<readonly LiveRouteGap[]> {
  const inBrowser = await islandModules(root);
  const reported = new Set<string>();
  const gaps: LiveRouteGap[] = [];
  for (const entry of entries) {
    if (entry.surface === 'api') continue;
    const never = entry.config.hydrate === 'never';
    for (const read of await browserOnlyReads(root, entry.file)) {
      if (reported.has(read.at) || (!never && inBrowser.has(read.at))) continue;
      reported.add(read.at);
      gaps.push({
        ...read,
        route: entry.path,
        file: entry.file,
        hydrate: entry.config.hydrate,
        islands: entry.islands,
      });
    }
  }
  return gaps;
}

export const liveRouteFindingFor = (gap: LiveRouteGap): Finding => ({
  code: 'X_LIVE_ROUTE_NO_ISLAND',
  cause:
    `${gap.route} reads ${gap.hook}() in ${gap.at}, which ` +
    (gap.hydrate === 'never' ? `sits on a route declaring hydrate: 'never'` : 'no island imports') +
    ' — so it only ever runs on the server, where it answers its server state (nothing, or loading) forever, at 200',
  fix:
    `move it into an island: ${generatorFor(gap.file)}, import ${gap.at} from that island's mount(), and declare it with island({ src: './${posix.basename(posix.dirname(gap.file))}${ISLAND_EXTENSION}' }) in ${gap.file}` +
    (gap.hydrate === 'never' ? `, with a hydrate other than 'never'` : ''),
  docs: ERROR_DOCS_URL,
  at: gap.at,
});

/**
 * What this rule contributes to `x verify`'s `budgets` step — the step that already loaded the app
 * and already asks what JavaScript a route's document boots.
 */
export const liveRouteFindings = async (root: string): Promise<readonly Finding[]> =>
  (await liveRouteGaps(root, routeEntries())).map(liveRouteFindingFor);
