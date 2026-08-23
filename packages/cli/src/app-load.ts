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

// A module is imported and registered exactly once per PROCESS: `import()` caches, and a registry
// rejects a second registration of a name. So a rescan refreshes only the facts DERIVED from the
// registries — the manifest and its build id — and never the primitives themselves: an edited route
// config, action or query needs a restart. Clearing the registries would not change that. Bun
// exposes no way to invalidate a cached module, so the re-import hands back the same stale exports,
// and a cache-busting query string leaks a fresh module instance on every save.
const registered = new Set<string>();
// A registration failure is sticky: the file is never retried, so the finding is replayed.
const failures = new Map<string, Finding>();

/** Test seam, and what `x dev` would call if it ever restarted the registries in-process. */
export function resetAppLoad(): void {
  registered.clear();
  failures.clear();
}

export async function loadApp(root: string): Promise<LoadedApp> {
  const files: string[] = [];
  const findings: Finding[] = [];

  for (const pattern of APP_GLOBS) {
    for await (const absolute of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
      if (absolute.includes('node_modules') || absolute.includes('.test.')) continue;
      const file = relative(root, absolute).split(sep).join('/');
      if (ENTRY_POINT.test(file) || CLIENT_ENTRY_POINT.test(file) || STATES_FILE.test(file)) {
        continue;
      }
      let module: Record<string, unknown>;
      try {
        module = (await import(absolute)) as Record<string, unknown>;
      } catch (error) {
        findings.push({ ...findingFrom(error), at: file });
        continue;
      }
      files.push(file);
      const finding = await register(absolute, file, module);
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

/** Registers a module once; every later call replays whatever the first one reported. */
async function register(
  absolute: string,
  file: string,
  module: Record<string, unknown>,
): Promise<Finding | undefined> {
  const previous = failures.get(absolute);
  if (previous !== undefined) return previous;
  if (registered.has(absolute)) return undefined;
  registered.add(absolute);
  try {
    const config = module['config'];
    if (isRouteConfig(config)) {
      // The build counts boundaries from the compiled JSX; before a build there is only the
      // source, and `render: 'stream'` is rejected without one — so count them in the text.
      const source = await Bun.file(absolute).text();
      // The page component comes from the same module as its config, resolved by render's own
      // rule — the CLI does not decide which export is a page any more than it decides what a
      // route is. A module with no component registers without one, and renders a bare shell.
      const component = pageComponentOf(module);
      registerRoute({
        file,
        config,
        suspenseBoundaries: countSuspense(source),
        ...(component === undefined ? {} : { component }),
      });
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
