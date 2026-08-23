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
import type { Finding } from './output';

/**
 * The exports that only work with a registered `LiveClient`. Each one either subscribes, mutates
 * or reads the connection, so a module naming one is a module that needs a browser to have booted
 * it — `hasLiveClient` and `LiveClient` itself are deliberately absent: the first IS the guard, and
 * the second is what an island's `mount()` constructs.
 */
export const LIVE_HOOKS = [
  'useLive',
  'liveHookFor',
  'useConnection',
  'useMutation',
  'useMutationQueue',
] as const;

/**
 * The one escape hatch, and it is a call an author writes on purpose: a module that ASKS whether
 * there is a client has already written what happens when there is none. `app/update-banner.tsx`
 * in the reference app is the shape — imported by the layout, so by every page, and correct on all
 * of them.
 */
const GUARD = 'hasLiveClient';

/** Value imports only: `import type` is erased, so it boots nothing and needs nothing. */
const REALTIME_IMPORT = /import\s+([^;]*?)from\s*['"]@ultimat3\/realtime(?:\/[\w-]+)?['"]/g;

const bindingsOf = (clause: string): readonly string[] =>
  (/\{([^}]*)\}/.exec(clause)?.[1] ?? '')
    .split(',')
    .map((entry) => entry.split(/\bas\b/)[0]?.trim() ?? '')
    .filter((name) => name.length > 0 && !name.startsWith('type '));

/**
 * Which live hooks one module imports, or `[]` — including for a module that guards, which is a
 * per-FILE verdict on purpose: the guard is written next to the read it protects.
 */
export function liveHooksIn(source: string): readonly string[] {
  const hooks: string[] = [];
  for (const match of source.matchAll(REALTIME_IMPORT)) {
    const clause = match[1] ?? '';
    if (clause.trimStart().startsWith('type ')) continue;
    const names = bindingsOf(clause);
    if (names.includes(GUARD)) return [];
    for (const hook of LIVE_HOOKS) if (names.includes(hook)) hooks.push(hook);
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
 * Walk the route module's own import graph and answer the first live hook in it.
 *
 * Relative specifiers only. A bare one resolves through `node_modules` or a workspace name, and
 * following either would mean guessing which package a name came from — the limit `fix-imports.ts`
 * records for the same walk. So this UNDER-reports rather than over-reports: a finding here is
 * always a real one, which is what lets the rule ship with no pin table.
 */
export async function liveReachOf(root: string, file: string): Promise<LiveReach | undefined> {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    const module = await readModule(root, next);
    if (module === undefined) continue;
    const hook = liveHooksIn(module.source)[0];
    if (hook !== undefined) return { at: module.path, hook };
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
 * Every route that reads live rows with nothing to receive them. Two shapes, one condition — no
 * island at all, and an island the route declares `hydrate: 'never'` for. `X_ISLAND_NOT_HYDRATED`
 * covers the second only at render time, and only for a render that reaches the island, so a route
 * can hold the contradiction and never be asked.
 */
export async function liveRouteGaps(
  root: string,
  entries: readonly RouteEntry[],
): Promise<readonly LiveRouteGap[]> {
  const gaps: LiveRouteGap[] = [];
  for (const entry of entries) {
    if (entry.surface === 'api') continue;
    if (entry.islands.length > 0 && entry.config.hydrate !== 'never') continue;
    const reach = await liveReachOf(root, entry.file);
    if (reach === undefined) continue;
    gaps.push({
      ...reach,
      route: entry.path,
      file: entry.file,
      hydrate: entry.config.hydrate,
      islands: entry.islands,
    });
  }
  return gaps;
}

export const liveRouteFindingFor = (gap: LiveRouteGap): Finding => ({
  code: 'X_LIVE_ROUTE_NO_ISLAND',
  cause:
    `${gap.route} reads ${gap.hook}() (${gap.at}) and ` +
    (gap.islands.length === 0
      ? 'declares no island'
      : `declares hydrate: 'never' beside ${gap.islands.join(', ')}`) +
    ', so no module of this route ever runs in a browser: its rows have nowhere to arrive and the page renders its loading branch forever, at 200',
  fix:
    `${generatorFor(gap.file)}, declare it with island({ src: './${posix.basename(posix.dirname(gap.file))}${ISLAND_EXTENSION}' }) above defineRoute in ${gap.file}, ` +
    `and move the ${gap.hook}() read into its mount() — which is where setLiveClient() can be called`,
  docs: ERROR_DOCS_URL,
  at: gap.at,
});

/**
 * What this rule contributes to `x verify`'s `budgets` step — the step that already loaded the app
 * and already asks what JavaScript a route's document boots.
 */
export const liveRouteFindings = async (root: string): Promise<readonly Finding[]> =>
  (await liveRouteGaps(root, routeEntries())).map(liveRouteFindingFor);
