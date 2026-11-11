// Loading an app into the framework's own registries. The CLI owns no second definition of what
// a primitive is: `entity()`, `job()` and `task()` register on import, and `registerActions` /
// `registerQueries` / `registerRoute` name the rest — so `x manifest`, `x routes` and `x verify`
// read exactly the tables the running server reads.

// Bun ships no `Bun.*` path API: `join`/`resolve` reach the files a scan imports.
import { join, resolve } from 'node:path';
import { listActions } from '@ultimat3/action';
import { APP_CONFIG_FILE } from '@ultimat3/core';
import { describeEntities } from '@ultimat3/entity';
import type { AppLocaleSet } from '@ultimat3/i18n/app-catalogs';
import { appLocaleSet, UNDECLARED_LOCALES } from '@ultimat3/i18n/app-catalogs';
import { registeredJobs, registeredTasks } from '@ultimat3/jobs';
import type { ErrorCodeFact } from '@ultimat3/manifest';
import { listQueries } from '@ultimat3/query';
import { routeEntries, setAssetResolver } from '@ultimat3/render';
// For the SIDE EFFECT, and it is this module's to hold: importing `@ultimat3/render/server`
// installs the `.tsx`/`.scss` Bun plugin, a plugin only transforms modules loaded AFTER it, and
// every app module below is loaded by the dynamic `import()` in this file. Before the render
// barrel split it came free with the line above; after it, the only other path to `/server` from
// here is six hops through `error-contract` → `fix-command` → the command registry, which is an
// accident one refactor away from compiling every app's `.tsx` to `React.createElement`. The named
// import is a value import, so the side effect holds without the bare line it replaced.
import { setStylesheetRoot } from '@ultimat3/render/server';
import { asyncModules } from './app-load-async';
import { importInOrder } from './app-load-batch';
import { isFirstPass, registeredAny, registerModule } from './app-load-register';
import { unresolvedImportFinding } from './app-load-unresolved';
import { evictChanged, trackModule, trackStylesheets } from './app-reload-graph';
import { API_INDEX } from './app-root';
import { collectDeclaredCodes } from './error-contract';
import type { Finding } from './output';
import { findingFrom } from './output';
import { hasPathSegment } from './path-segments';
import { posixRelative, toPosix } from './posix-path';
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
 * `apps/<app>/exercise.ts` is `x exercise`'s input, read by that command alone. It imports
 * `@ultimat3/testing`, a devDependency a production image does not install, so the boot scan that
 * imported it would fail the module on every start.
 */
const EXERCISE_FILE = /^apps\/[^/]+\/exercise\.ts$/;

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
   * The app's locales, default first — `@ultimat3/i18n`'s `appLocaleSet`, the ONE reader of
   * `defineCatalogs()`, asked once here so every step after the load reads one answer. Never
   * `localeConfig()` read blind (it answers an earlier import's declaration for an app that made
   * none) and never a regex over the source. An app with no catalogs, or whose catalog module would
   * not import (the scan's finding already says so), is `UNDECLARED_LOCALES`.
   */
  readonly locales: AppLocaleSet;
  /** Modules that would not import, and primitives that would not register. */
  readonly findings: readonly Finding[];
}

// Registration, and the once-per-process state behind it, is `app-load-register.ts`'s.
export { resetAppLoad } from './app-load-register';

/**
 * One glob's hits in code-unit order of their POSIX spelling — never the host's. Sorted raw, `\`
 * (0x5C) sorts after a digit or a capital where `/` (0x2F) sorts before one, so Windows imported
 * `app/a1/page.tsx` before `app/a/page.tsx` and Linux after: one app, two cascades.
 */
export function sortModulePaths(paths: readonly string[]): string[] {
  const keyed = paths.map((path) => ({ path, key: toPosix(path) }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map((one) => one.path);
}

/**
 * Every module path the app globs match, SORTED — with the API index first. `Bun.Glob` answers in
 * directory order, which is the filesystem's — ext4 hashes names with a per-filesystem seed — so
 * two pods of one image imported the app in two orders, registered its stylesheets in two orders,
 * and served two different `/styles/<hash>.css` for one page (one adopter, 22.3.2). Import order
 * is the stylesheet cascade's order, so it must be the same everywhere.
 *
 * The API index leads because `defineApi({ http: { pathStyle } })` is what every action URL is
 * derived under: sorted, `apps/admin/**` evaluated before it, and a module-level
 * `derivePath('signOut').path` there captured the default style's `/api/outs/sign` — a form
 * posting to a URL no route served (one adopter, 22.6.0). Anything still evaluated before the
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
    found.push(...sortModulePaths(matched));
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
  prepareAppImport(root);
  // A rescan: whatever changed on disk since the last one, and everything importing it, leaves
  // Bun's module registry before the loop below imports it again.
  const rescan = options.track && registeredAny();
  if (rescan) await evictChanged(root);
  const candidates = (await appModulePaths(root)).filter((absolute) =>
    isScannedModule(root, absolute),
  );
  // `include` is asked before each import, of the process as the PREVIOUS import left it — the
  // role load and the gate's probe both read that state — so a scan that asks it is serial. A
  // rescan is too: it imports what it evicted, and every other module answers from the cache.
  const scan =
    options.include === undefined && !rescan
      ? await scanBatched(root, candidates, options.track)
      : await scanSerial(root, candidates, options);
  scan.files.sort();
  return scan;
}

/** What every import of the app's modules needs first: the scan's, and the prebuilt registry's. */
export function prepareAppImport(root: string): void {
  // Before any import: a stylesheet's surface is read below the app root, never off its absolute
  // path — under the container's `WORKDIR /app` that path's first segment is `app/`, and every
  // sheet, the site's included, classified as app CSS.
  setStylesheetRoot(root);
  // And before any page renders: `asset('assets/…')` answers from this app's own table, in
  // `x dev`, the container and the static build alike — one install, three processes.
  const assets = siteAssetTable(root);
  setAssetResolver((path) => assets.resolve(path).url);
}

/** Mutable while a scan fills it; handed out as an `AppScan`. */
interface ScanResult {
  readonly files: string[];
  readonly findings: Finding[];
}

/**
 * Whether the scan imports `absolute` at all — the one rule, for the scan, the prebuilt registry
 * and `x g`'s "does this write change the manifest?" (`generate-refresh.ts`).
 */
export function isScannedModule(root: string, absolute: string): boolean {
  // A SEGMENT, never a substring: an app checked out under
  // `~/dev/node_modules-experiments/myapp` answered `includes('node_modules')` for every
  // file it holds, so this loop imported none of them and the app registered nothing.
  // The ROOT-RELATIVE path is tested, never the absolute one: an app checked out under
  // `~/work/my.test.app` matched `.test.` on every file and loaded none of them, and one under
  // `<anything>/node_modules/<app>` matched the segment on every file the same way.
  const file = posixRelative(root, absolute);
  if (hasPathSegment(file, 'node_modules') || isTest(file)) return false;
  return !(
    ENTRY_POINT.test(file) ||
    EXERCISE_FILE.test(file) ||
    CLIENT_ENTRY_POINT.test(file) ||
    STATES_FILE.test(file)
  );
}

/**
 * Whether the scan would import the file at `path` (app-root-relative) if it existed: one of the
 * scan's globs matches it and `isScannedModule` admits it. For a caller holding a path, not a
 * glob's answer — `x g` asking whether a file it wrote is an app module (`generate-refresh.ts`).
 */
export function isAppModulePath(root: string, path: string): boolean {
  const file = toPosix(path);
  return (
    APP_GLOBS.some((pattern) => new Bun.Glob(pattern).match(file)) &&
    isScannedModule(root, resolve(root, file))
  );
}

/** Every module the scan would import, in its order — what `x build` writes the registry from. */
export async function scannedModulePaths(root: string): Promise<readonly string[]> {
  return (await appModulePaths(root)).filter((absolute) => isScannedModule(root, absolute));
}

/** A module that would not import, keyed by its file. */
const importFinding = (error: unknown, root: string, file: string): Finding =>
  unresolvedImportFinding(error, root) ?? { ...findingFrom(error), at: file };

/** Reads at most this many sources at once: a 12k-module app opened 12k descriptors otherwise. */
const READ_BATCH = 64;

/**
 * Every candidate imported in `importInOrder`'s batches and registered as it evaluates — before
 * the next module evaluates, as `scanSerial` does. The sources of a tracked scan are all read
 * BEFORE any import, for the reason `scanSerial` reads each one before its own: what is recorded
 * is bound to the bytes that module was evaluated from.
 */
async function scanBatched(
  root: string,
  candidates: readonly string[],
  track: boolean,
): Promise<ScanResult> {
  if (track) {
    const first = candidates.filter(isFirstPass);
    for (let start = 0; start < first.length; start += READ_BATCH) {
      const batch = first.slice(start, start + READ_BATCH);
      const sources = await Promise.all(batch.map((absolute) => Bun.file(absolute).text()));
      for (const [index, absolute] of batch.entries()) {
        await trackModule(absolute, sources[index] as string, root);
      }
    }
  }
  const registered = new Map<number, Finding>();
  const register = (index: number, module: Record<string, unknown>): void => {
    const absolute = candidates[index] as string;
    const file = posixRelative(root, absolute);
    const finding = registerModule(module, { absolute, file, track });
    if (finding !== undefined) registered.set(index, finding);
  };
  // A module that can suspend is imported on its own, or a sibling would evaluate before it ends.
  const alone = await asyncModules(root, candidates);
  const imported = await importInOrder(candidates, alone, register);
  const result: ScanResult = { files: [], findings: [] };
  for (const [index, absolute] of candidates.entries()) {
    const file = posixRelative(root, absolute);
    const one = imported[index];
    if (one === undefined) continue;
    if (!one.ok) {
      result.findings.push(importFinding(one.error, root, file));
      continue;
    }
    result.files.push(file);
    const finding = registered.get(index);
    if (finding !== undefined) result.findings.push(finding);
  }
  return result;
}

/** One module at a time: `include` asked, the source read, the module imported and registered. */
async function scanSerial(
  root: string,
  candidates: readonly string[],
  options: ScanOptions,
): Promise<ScanResult> {
  const result: ScanResult = { files: [], findings: [] };
  for (const absolute of candidates) {
    const file = posixRelative(root, absolute);
    if (options.include !== undefined && !(await options.include(absolute))) continue;
    // The source is read BEFORE the import, on the file's first pass — a rescan of a registered
    // module reads nothing here. What is recorded is bound to the bytes the module was evaluated
    // from, and a read AFTER the import cannot know which bytes those were: a save landing between
    // the two bound V1's component to V2's hash, so the next scan saw nothing to do and served V1
    // until the save after. Read first, the worst case is one re-import the next tick, of a file
    // that did change. An untracked scan reads nothing here: no save lands in an image.
    const first = isFirstPass(absolute);
    const snapshot = options.track && first ? await Bun.file(absolute).text() : undefined;
    if (first && snapshot !== undefined) await trackModule(absolute, snapshot, root);
    let module: Record<string, unknown>;
    try {
      module = (await import(absolute)) as Record<string, unknown>;
    } catch (error) {
      result.findings.push(importFinding(error, root, file));
      continue;
    }
    result.files.push(file);
    const finding = registerModule(module, { absolute, file, track: options.track });
    if (finding !== undefined) result.findings.push(finding);
  }
  return result;
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
  return {
    root,
    files: scan.files,
    errorCodes: await appErrorCodes(root),
    locales: await loadedLocales(root),
    findings,
  };
}

/**
 * After the scan, never before it: the scan imported the catalog module, so the set it exports is
 * what `loadAppCatalogs` recognises. A module that would not import is the scan's finding, not a
 * second one here.
 */
async function loadedLocales(root: string): Promise<AppLocaleSet> {
  try {
    return await appLocaleSet(root);
  } catch {
    return UNDECLARED_LOCALES;
  }
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
 * `packages/db/src/errors.ts` → `packages/db`; `apps/web/app/posts/errors.ts` → `apps/web` — on
 * either separator. A manifest written on Windows split a `\`-path on `/`, kept the whole file as
 * the "package" (`apps\\admin\\app\\…\\abuse.tsx`) and sorted the codes by it, so the same tree
 * regenerated thousands of changed lines on the next Linux machine and `--check` meant nothing.
 */
export const workspaceOf = (file: string): string => toPosix(file).split('/').slice(0, 2).join('/');

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
