// Loading an app into the framework's own registries. The CLI owns no second definition of what
// a primitive is: `entity()`, `job()` and `task()` register on import, and `registerActions` /
// `registerQueries` / `registerRoute` name the rest — so `x manifest`, `x routes` and `x verify`
// read exactly the tables the running server reads.

// Bun ships no `Bun.*` path API: `relative`/`sep` turn an absolute scan hit into the app-root-
// relative POSIX path every finding and every manifest fact is keyed by.
import { relative, sep } from 'node:path';
import { registerActions } from '@ultimat3/action';
import { localeConfig } from '@ultimat3/i18n';
import type { ErrorCodeFact } from '@ultimat3/manifest';
import { registerQueries } from '@ultimat3/query';
import type { RouteConfig } from '@ultimat3/render';
import { isRouteConfig, pageComponentOf, registerRoute } from '@ultimat3/render';
// For the SIDE EFFECT, and it is this module's to hold: importing `@ultimat3/render/server`
// installs the `.tsx`/`.scss` Bun plugin, a plugin only transforms modules loaded AFTER it, and
// every app module below is loaded by the dynamic `import()` in this file. Before the render
// barrel split it came free with the line above; after it, the only other path to `/server` from
// here is six hops through `error-contract` → `fix-command` → the command registry, which is an
// accident one refactor away from compiling every app's `.tsx` to `React.createElement`.
import '@ultimat3/render/server';
import { collectDeclaredCodes } from './error-contract';
import type { Finding } from './output';
import { findingFrom } from './output';
import { hasPathSegment } from './path-segments';

/** Every place an app keeps code the framework has to see. */
const APP_GLOBS = [
  'apps/*/{site,app,api,shared}/**/*.{ts,tsx}',
  'apps/*/*.{ts,tsx}',
  'packages/*/src/**/*.ts',
] as const;

/**
 * The two files that are *entry points*, not app modules: `apps/web/server.ts` starts the process
 * and `apps/web/prerender.ts` runs the build. Importing either registers nothing — and importing
 * `server.ts` deadlocks, because that module's own top-level `await runRole()` is what called this
 * scan, so the dynamic import waits on a module that is waiting on the import. Anchored to the
 * surface root: `apps/web/app/server.ts` is app code and stays in the scan.
 */
const ENTRY_POINT = /^apps\/[^/]+\/(?:server|prerender)\.tsx?$/;

/**
 * A `*.island.tsx` is a CLIENT entry point and is deliberately not imported here. It registers no
 * primitive — a page names it by specifier, never by import — and importing it would put the one
 * module the framework guarantees is outside the server's graph inside this process's, where a
 * top-level `document` reference takes the whole scan down (axiom 6).
 */
const CLIENT_ENTRY_POINT = /\.island\.tsx$/;

/**
 * A `*.island.states.ts` is read by a TOOL, not by the server: `x shot --island` loads it, the
 * harness route loads it, and a guard test loads it. It registers no primitive and it imports
 * `@ultimat3/testing`, so importing it here would put the test-support package in the module graph
 * of every `x dev`, every `x build` and every gate step that loads the app — the same rule the
 * client entry point above follows, for the same reason (axiom 6).
 */
const STATES_FILE = /\.island\.states\.ts$/;

export interface LoadedApp {
  readonly root: string;
  /** App-root-relative POSIX paths of every module that imported, sorted. */
  readonly files: readonly string[];
  /** Every `X_*` code the app's source declares, by code — the one fact no registry holds. */
  readonly errorCodes: readonly ErrorCodeFact[];
  /**
   * The locale the app falls back to. `packages/i18n/src/index.ts` is inside the import loop, and
   * `defineCatalogs()` configures `@ultimat3/i18n` on its way through — so this is the framework's
   * own answer, read back from `localeConfig()`, and never a regex over the app's source, which
   * only ever matched the one `defineCatalogs({ default: '…' })` spelling it anticipated. An app
   * whose i18n module would not import leaves the framework default (`en`) and a finding saying so.
   */
  readonly defaultLocale: string;
  /** Modules that would not import, and primitives that would not register. */
  readonly findings: readonly Finding[];
}

// A module is imported and registered once per PROCESS: `import()` caches, and a registry rejects
// a second registration of a name. So a rescan refreshes the facts DERIVED from the registries —
// the manifest and its build id — and, for exactly one kind of module, the primitive itself. A
// ROUTE module whose source changed is imported again under `?x-reload=<hash>`, the one cache key
// Bun honours, and `registerRoute` replaces the entry for the same file; its own imports resolve
// to the modules already cached, which is what makes it safe. An action, a query or an entity
// stays registered once: its exports are held by every module that imported it, a second instance
// would be a duplicate name in its registry, and no re-import can rebind the importers — those
// edits need a restart. Until 2026-09-07 the route module took the same rule, so a save re-bundled
// the island (`buildIslands` reads the disk) and kept the FIRST page component — a new island
// rendering under an old page's props, which is the mixed generation `x dev` served.
const registered = new Set<string>();
// A registration failure is sticky: the file is never retried, so the finding is replayed.
const failures = new Map<string, Finding>();
// Route modules only: the hash of the source each one registered from, which is what a rescan
// compares the disk against. A save that leaves the bytes alone re-imports nothing.
const routeSources = new Map<string, bigint>();

/** The query a re-imported route module carries. `module-loader.ts`'s filter admits it. */
const RELOAD_QUERY = 'x-reload';

/** Test seam, and what `x dev` would call if it ever restarted the registries in-process. */
export function resetAppLoad(): void {
  registered.clear();
  failures.clear();
  routeSources.clear();
}

export async function loadApp(root: string): Promise<LoadedApp> {
  const files: string[] = [];
  const findings: Finding[] = [];

  for (const pattern of APP_GLOBS) {
    for await (const absolute of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
      // A SEGMENT, never a substring: an app checked out under
      // `~/dev/node_modules-experiments/myapp` answered `includes('node_modules')` for every
      // file it holds, so this loop imported none of them and the app registered nothing.
      if (hasPathSegment(absolute, 'node_modules') || absolute.includes('.test.')) continue;
      const file = relative(root, absolute).split(sep).join('/');
      if (ENTRY_POINT.test(file) || CLIENT_ENTRY_POINT.test(file) || STATES_FILE.test(file)) {
        continue;
      }
      // The source is read BEFORE the import, and only on the file's first pass — a rescan of a
      // registered module reads nothing here. A route entry is bound to the bytes the module was
      // evaluated from, and a read AFTER the import cannot know which bytes those were: a save
      // landing between the two bound V1's component to V2's hash, so the next scan saw nothing to
      // do and served V1 until the save after. Read first, the worst case is one re-import the
      // next tick, of a file that did change.
      const snapshot = registered.has(absolute) ? undefined : await Bun.file(absolute).text();
      let module: Record<string, unknown>;
      try {
        module = (await import(absolute)) as Record<string, unknown>;
      } catch (error) {
        findings.push({ ...findingFrom(error), at: file });
        continue;
      }
      files.push(file);
      const finding = await register(absolute, file, module, snapshot);
      if (finding !== undefined) findings.push(finding);
    }
  }

  files.sort();
  // Read after the loop, never before it: `configureLocales` runs on the app's own import.
  return {
    root,
    files,
    errorCodes: await appErrorCodes(root),
    defaultLocale: localeConfig().fallback,
    findings,
  };
}

/**
 * Registers a module once; every later call replays whatever the first one reported — except for
 * a route module, which a later call re-registers from disk when its source has changed.
 * `snapshot` is the source read before the module's first import, and absent on every later call.
 */
async function register(
  absolute: string,
  file: string,
  module: Record<string, unknown>,
  snapshot: string | undefined,
): Promise<Finding | undefined> {
  const previous = failures.get(absolute);
  if (previous !== undefined) return previous;
  if (snapshot === undefined) return reloadRoute(absolute, file);
  registered.add(absolute);
  try {
    const config = module['config'];
    const route = isRouteConfig(config) ? config : undefined;
    if (route !== undefined) registerRouteModule(file, module, route, snapshot);
    registerActions(module);
    registerQueries(module);
    // Only a route module is ever re-imported, so only a route module's hash is worth keeping.
    if (route !== undefined) routeSources.set(absolute, Bun.hash.wyhash(snapshot));
    return undefined;
  } catch (error) {
    const finding: Finding = { ...findingFrom(error), at: file };
    failures.set(absolute, finding);
    return finding;
  }
}

/**
 * The route half of a registration, and the whole of a re-registration. `source` is the text the
 * module was imported from — read by the caller BEFORE the import, never here after it — and the
 * hash the entry is bound to is that text's. Until 2026-09-07 this read the file again, and a save
 * between the import and that read registered the old component under the new hash: the next
 * scan compared equal, and the page on disk was not served until the save after it.
 */
function registerRouteModule(
  file: string,
  module: Record<string, unknown>,
  config: RouteConfig,
  source: string,
): void {
  // The page component comes from the same module as its config, resolved by render's own
  // rule — the CLI does not decide which export is a page any more than it decides what a
  // route is. A module with no component registers without one, and renders a bare shell.
  const component = pageComponentOf(module);
  registerRoute({
    file,
    config,
    // The build counts boundaries from the compiled JSX; before a build there is only the
    // source, and `render: 'stream'` is rejected without one — so count them in the text.
    suspenseBoundaries: countSuspense(source),
    ...(component === undefined ? {} : { component }),
  });
}

/**
 * A registered route module, on a rescan: imported again if the file no longer hashes to what it
 * registered from, and left alone otherwise. A save that will not import is a finding at the file
 * and NOT a sticky one — the next save is tried again — and the entry it would have replaced stays
 * registered, so the last page that did import is the one served meanwhile.
 */
async function reloadRoute(absolute: string, file: string): Promise<Finding | undefined> {
  const registeredFrom = routeSources.get(absolute);
  if (registeredFrom === undefined) return undefined;
  const source = await Bun.file(absolute).text();
  const hash = Bun.hash.wyhash(source);
  if (hash === registeredFrom) return undefined;
  try {
    const module = (await import(`${absolute}?${RELOAD_QUERY}=${hash}`)) as Record<string, unknown>;
    const config = module['config'];
    // A file that stopped being a route is not un-registered — the table has no verb for it, and a
    // deleted file needs a restart either way. Its hash is recorded so the same save is not
    // re-imported on every later tick.
    if (isRouteConfig(config)) registerRouteModule(file, module, config, source);
    routeSources.set(absolute, hash);
    return undefined;
  } catch (error) {
    return { ...findingFrom(error), at: file };
  }
}

const countSuspense = (source: string): number => source.match(/<Suspense[\s/>]/g)?.length ?? 0;

/** `packages/db/src/errors.ts` → `packages/db`; `apps/web/app/posts/errors.ts` → `apps/web`. */
const workspaceOf = (file: string): string => file.split('/').slice(0, 2).join('/');

/**
 * The app's `X_*` codes, from the same walk and the same scanner the `errors` gate step uses.
 * Deliberately not a second scan of the loaded modules' `*_ERROR_CODES` exports: that array is a
 * convention some apps follow and most do not, so an app that declares every code at its throw
 * site — the reference app included — published `"errorCodes": []`, a manifest claiming a
 * completeness it never had. `collectDeclaredCodes` is the only answer to "which codes exist?",
 * already sorted by code and one entry per code, so the projection is just the owning workspace.
 */
const appErrorCodes = async (root: string): Promise<readonly ErrorCodeFact[]> =>
  (await collectDeclaredCodes(root)).map((site) => ({
    code: site.code,
    package: workspaceOf(site.at),
  }));
