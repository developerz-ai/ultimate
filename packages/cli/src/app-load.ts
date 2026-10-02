// Loading an app into the framework's own registries. The CLI owns no second definition of what
// a primitive is: `entity()`, `job()` and `task()` register on import, and `registerActions` /
// `registerQueries` / `registerRoute` name the rest — so `x manifest`, `x routes` and `x verify`
// read exactly the tables the running server reads.

// Bun ships no `Bun.*` path API: `relative`/`sep` turn an absolute scan hit into the app-root-
// relative POSIX path every finding and every manifest fact is keyed by.
import { join, relative, resolve, sep } from 'node:path';
import { isAction, isMutator, listActions, registerActions } from '@ultimat3/action';
import { describeEntities, registeredEntities } from '@ultimat3/entity';
import { localeConfig } from '@ultimat3/i18n';
import { isJobHandle, isTaskHandle, registeredJobs, registeredTasks } from '@ultimat3/jobs';
import type { ErrorCodeFact } from '@ultimat3/manifest';
import { isQuery, listQueries, registerQueries } from '@ultimat3/query';
import type { RouteConfig } from '@ultimat3/render';
import {
  isRouteConfig,
  pageComponentOf,
  registerRoute,
  routeEntries,
  setAssetResolver,
} from '@ultimat3/render';
// For the SIDE EFFECT, and it is this module's to hold: importing `@ultimat3/render/server`
// installs the `.tsx`/`.scss` Bun plugin, a plugin only transforms modules loaded AFTER it, and
// every app module below is loaded by the dynamic `import()` in this file. Before the render
// barrel split it came free with the line above; after it, the only other path to `/server` from
// here is six hops through `error-contract` → `fix-command` → the command registry, which is an
// accident one refactor away from compiling every app's `.tsx` to `React.createElement`. The named
// import is a value import, so the side effect holds without the bare line it replaced.
import { setStylesheetRoot } from '@ultimat3/render/server';
import {
  evictChanged,
  pinModule,
  resetReloadGraph,
  trackModule,
  trackStylesheets,
} from './app-reload-graph';
import { API_INDEX, APP_CONFIG_FILE } from './app-root';
import { collectDeclaredCodes } from './error-contract';
import type { Finding } from './output';
import { findingFrom } from './output';
import { hasPathSegment } from './path-segments';
import { siteAssetTable } from './site-assets';
import { isTest } from './source-files';

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
// the manifest and its build id — and, for exactly one kind of module, the registration itself. A
// rescan first evicts every changed module, and everything that imports it, from Bun's registry
// (`app-reload-graph.ts`), so the loop's own `import()` evaluates the new chain; a ROUTE module
// that comes back as a different instance has its entry replaced. A module that defines a
// primitive (an action, a query, an entity, a job, a task) is pinned instead — its exports are held
// by every importer and a second instance would be a duplicate name in its registry — so those
// edits still need a restart. Until 2026-09-27 only the route module itself was re-imported, under
// `?x-reload=<hash>`, and every component it imports stayed the cached one: `x dev` logged
// "reloaded" and served the old component.
const registered = new Set<string>();
// A registration failure is sticky: the file is never retried, so the finding is replayed.
const failures = new Map<string, Finding>();
// Route modules only: the module instance each one registered from. A rescan that imports the same
// instance registers nothing; a different one (the file or something it imports was evicted) is
// the page the author saved.
const routeModules = new Map<string, Record<string, unknown>>();

/** Test seam, and what `x dev` would call if it ever restarted the registries in-process. */
export function resetAppLoad(): void {
  registered.clear();
  failures.clear();
  routeModules.clear();
  resetReloadGraph();
}

/**
 * Every module path the app globs match, SORTED — with the API index first. `Bun.Glob` answers in
 * directory order, which is the filesystem's — ext4 hashes names with a per-filesystem seed — so
 * two pods of one image imported the app in two orders, registered its stylesheets in two orders,
 * and served two different `/styles/<hash>.css` for one page (notificado.co, 22.3.2). Import order
 * is the stylesheet cascade's order, so it must be the same everywhere.
 *
 * The API index leads because `defineApi({ http: { pathStyle } })` is what every action URL is
 * derived under: sorted, `apps/admin/**` evaluated before it, and a module-level
 * `derivePath('signOut').path` there captured the default style's `/api/outs/sign` — a form
 * posting to a URL no route served (notificado.co, 22.6.0). Anything still evaluated before the
 * declaration (the index's own imports) is refused at it, `X_ACTION_PATH_DERIVED_EARLY`.
 */
export async function appModulePaths(root: string): Promise<readonly string[]> {
  // Pattern by pattern, as before — only the order WITHIN a pattern was the filesystem's.
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of APP_GLOBS) {
    const matched: string[] = [];
    for await (const absolute of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
      if (!seen.has(absolute)) matched.push(absolute);
      seen.add(absolute);
    }
    found.push(...matched.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  // Resolved, like the glob's own answers: `loadApp('.')` is a legal call.
  const index = resolve(root, API_INDEX);
  return found.includes(index) ? [index, ...found.filter((path) => path !== index)] : found;
}

/** What one scan of the app's modules imported, and what would not. */
export interface AppScan {
  /** App-root-relative POSIX paths of every module that imported, sorted. */
  readonly files: readonly string[];
  /** Modules that would not import, and primitives that would not register. */
  readonly findings: readonly Finding[];
}

export interface ScanOptions {
  /**
   * Records each module's bytes and pins so a LATER scan can evict what changed: a tool's and
   * `x dev`'s. A container scans once per process, so its boot passes `false` and neither reads a
   * module before importing it nor hashes one (`role-load.ts`).
   */
  readonly track: boolean;
  /** `false` leaves a module out: neither read nor imported. Absent: every module is imported. */
  readonly include?: (absolute: string) => boolean | Promise<boolean>;
}

/**
 * The scan itself: every app module `options.include` admits, imported in `appModulePaths` order
 * and registered. `loadApp` is this plus the facts a tool reads; a container role calls it through
 * `loadAppForRole`, which decides what the role imports.
 */
export async function scanAppModules(root: string, options: ScanOptions): Promise<AppScan> {
  // Before any import: a stylesheet's surface is read below the app root, never off its absolute
  // path — under the container's `WORKDIR /app` that path's first segment is `app/`, and every
  // sheet, the site's included, classified as app CSS.
  setStylesheetRoot(root);
  // And before any page renders: `asset('assets/…')` answers from this app's own table, in
  // `x dev`, the container and the static build alike — one install, three processes.
  const assets = siteAssetTable(root);
  setAssetResolver((path) => assets.resolve(path).url);
  const files: string[] = [];
  const findings: Finding[] = [];
  // A rescan: whatever changed on disk since the last one, and everything importing it, leaves
  // Bun's module registry before the loop below imports it again.
  if (options.track && registered.size > 0) await evictChanged(root);

  for (const absolute of await appModulePaths(root)) {
    // A SEGMENT, never a substring: an app checked out under
    // `~/dev/node_modules-experiments/myapp` answered `includes('node_modules')` for every
    // file it holds, so this loop imported none of them and the app registered nothing.
    // The ROOT-RELATIVE path is tested, never the absolute one: an app checked out under
    // `~/work/my.test.app` matched `.test.` on every file and loaded none of them.
    const file = relative(root, absolute).split(sep).join('/');
    if (hasPathSegment(absolute, 'node_modules') || isTest(file)) continue;
    if (ENTRY_POINT.test(file) || CLIENT_ENTRY_POINT.test(file) || STATES_FILE.test(file)) {
      continue;
    }
    if (options.include !== undefined && !(await options.include(absolute))) continue;
    // The source is read BEFORE the import, on the file's first pass and for every route module —
    // a rescan of any other registered module reads nothing here. What is recorded is bound to the
    // bytes the module was evaluated from, and a read AFTER the import cannot know which bytes
    // those were: a save landing between the two bound V1's component to V2's hash, so the next
    // scan saw nothing to do and served V1 until the save after. Read first, the worst case is one
    // re-import the next tick, of a file that did change. An untracked scan reads nothing here:
    // no save lands in an image, so a route module's text is read after its import, once.
    const first = !registered.has(absolute) && !failures.has(absolute);
    const snapshot =
      options.track && (first || routeModules.has(absolute))
        ? await Bun.file(absolute).text()
        : undefined;
    if (first && snapshot !== undefined) await trackModule(absolute, snapshot, root);
    let module: Record<string, unknown>;
    try {
      module = (await import(absolute)) as Record<string, unknown>;
    } catch (error) {
      findings.push({ ...findingFrom(error), at: file });
      continue;
    }
    files.push(file);
    const finding = await register(absolute, file, module, snapshot, options.track);
    if (finding !== undefined) findings.push(finding);
  }

  files.sort();
  return { files, findings };
}

export async function loadApp(root: string): Promise<LoadedApp> {
  const scan = await scanAppModules(root, { track: true });
  // After the scan, because the scan is what mounts an admin: a declaration the globs above cannot
  // reach is a finding here, owned by `manifest` like every other load finding. Imported here, not
  // at the top: a container boots through `scanAppModules` and never asks (`serve-graph.test.ts`).
  const { unscannedAdminFindings } = await import('./unscanned-admin');
  const findings = [...scan.findings, ...(await unscannedAdminFindings(root))];
  await trackStylesheets(root);
  // An app that imported NOTHING and reported nothing is a registry every later step reads as
  // empty-and-fine. With an `app.config.ts` beside it, that is never what the author meant.
  if (
    scan.files.length === 0 &&
    findings.length === 0 &&
    registersNothing() &&
    (await Bun.file(join(root, APP_CONFIG_FILE)).exists())
  ) {
    findings.push(emptyAppFinding(root));
  }
  // Read after the loop, never before it: `configureLocales` runs on the app's own import.
  return {
    root,
    files: scan.files,
    errorCodes: await appErrorCodes(root),
    defaultLocale: localeConfig().fallback,
    findings,
  };
}

/** No primitive in any registry this scan fills — a process that registered some itself is not empty. */
const registersNothing = (): boolean =>
  listActions().length === 0 &&
  listQueries().length === 0 &&
  routeEntries().length === 0 &&
  registeredJobs().length === 0 &&
  registeredTasks().length === 0 &&
  describeEntities().length === 0;

const emptyAppFinding = (root: string): Finding => ({
  code: 'X_APP_EMPTY',
  cause: `${root} has an ${APP_CONFIG_FILE} and loadApp imported no module under ${APP_GLOBS.join(', ')}, so every step reading the registries would check nothing`,
  fix: 'x doctor --json',
  at: APP_CONFIG_FILE,
});

/**
 * Registers a module once; every later call replays whatever the first one reported — except for
 * a route module, which a later call re-registers when the import handed back a new instance.
 * `snapshot` is the source read before this import: always for a first pass and a route module of
 * a TRACKED scan. An untracked one hands none, and a route module's text is read here instead.
 */
async function register(
  absolute: string,
  file: string,
  module: Record<string, unknown>,
  snapshot: string | undefined,
  track: boolean,
): Promise<Finding | undefined> {
  const previous = failures.get(absolute);
  if (previous !== undefined) return previous;
  if (registered.has(absolute)) return reloadRoute(absolute, file, module, snapshot);
  registered.add(absolute);
  try {
    const config = module['config'];
    const route = isRouteConfig(config) ? config : undefined;
    if (route !== undefined) {
      registerRouteModule(file, module, route, snapshot ?? (await Bun.file(absolute).text()));
      routeModules.set(absolute, module);
    }
    // A pin is the reload graph's: it stops an eviction a process that never rescans never runs,
    // and deciding it walks every export of every module against the entity registry.
    if (track && (definesPrimitive(module, route !== undefined) || file === API_INDEX)) {
      pinModule(absolute);
    }
    registerActions(module);
    registerQueries(module);
    return undefined;
  } catch (error) {
    const finding: Finding = { ...findingFrom(error), at: file };
    failures.set(absolute, finding);
    return finding;
  }
}

/**
 * A module whose instance must be the one every importer and every registry holds. A route module
 * may export an action beside its page — it has always been re-imported, and its actions stayed
 * registered from the first instance — so only an entity, a job or a task pins a route.
 */
function definesPrimitive(module: Record<string, unknown>, route: boolean): boolean {
  // The registry holds an entry per entity; the value a module exports is the entry's `core`.
  const entities = new Set<unknown>(registeredEntities().flatMap((entry) => [entry, entry.core]));
  const defines = (value: unknown): boolean =>
    entities.has(value) ||
    isJobHandle(value) ||
    isTaskHandle(value) ||
    (!route && (isAction(value) || isQuery(value) || isMutator(value)));
  return Object.values(module).some((value) => {
    // A brand check reads a property, and an export may be a proxy whose every read throws until
    // the env is set — examples/dummy's typed client throws X_ENV_MISSING without APP_URL. A value
    // that cannot be asked is not a primitive: every primitive is a plain branded object.
    try {
      return defines(value);
    } catch {
      return false;
    }
  });
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
 * A registered route module, on a rescan: re-registered when the import handed back a different
 * instance — the file or something it imports was evicted — and left alone otherwise. A save that
 * will not import never reaches here (the loop reports it, not sticky), so the last page that did
 * import is the one served meanwhile.
 */
function reloadRoute(
  absolute: string,
  file: string,
  module: Record<string, unknown>,
  source: string | undefined,
): Finding | undefined {
  const held = routeModules.get(absolute);
  if (held === undefined || held === module || source === undefined) return undefined;
  try {
    const config = module['config'];
    // A file that stopped being a route is not un-registered — the table has no verb for it, and a
    // deleted file needs a restart either way. Its instance is recorded so the same save is not
    // re-registered on every later tick.
    if (isRouteConfig(config)) registerRouteModule(file, module, config, source);
    routeModules.set(absolute, module);
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
