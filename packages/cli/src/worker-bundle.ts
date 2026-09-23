// The page's framework scripts (plan 101), each built as its own classic-script browser bundle,
// addressed by a hash of its source graph, served `immutable` by the same route in `x dev` and the
// container: the ONE sync worker (`@ultimat3/realtime/sync-worker`, slice 11) and the ONE page boot
// (`@ultimat3/realtime/boot` — the disk restore and the outbox, once per page instead of once per
// island). A new deploy is a new URL, so an old tab keeps what it started with.

// why: Bun ships no path API; the entry is resolved to a file and named in the cause.
import { dirname, join, relative } from 'node:path';
import type { Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders, json } from '@ultimat3/http';
import { FrameworkScriptBuildFailedError, type FrameworkScriptKind } from './errors';
import { describeBuildError, graphHash, stripDebugId } from './island-bundle';

/** Under the dev namespace `/_x` — where the socket it opens (`/_x/sync`) already lives. */
export const SYNC_WORKER_BASE_PATH = '/_x/sync-worker';

/** What an app resolves: realtime's worker entry, from the APP's install, never the CLI's own. */
export const SYNC_WORKER_SPECIFIER = '@ultimat3/realtime/sync-worker';

/** Under the dev namespace too; one per document that carries a principal scope. */
export const PAGE_BOOT_BASE_PATH = '/_x/page-boot';

/** Realtime's page boot, from the APP's install. */
export const PAGE_BOOT_SPECIFIER = '@ultimat3/realtime/boot';

/** One framework script: the sync worker or the page boot. */
export interface FrameworkScript {
  /** `<base>/<hash>.js` — what the document names. */
  readonly url: string;
  readonly code: string;
  readonly bytes: number;
}

/** The worker, by the name every caller already uses. */
export type SyncWorkerChunk = FrameworkScript;

export interface BuildSyncWorkerOptions {
  /** An absolute entry path. Absent resolves `SYNC_WORKER_SPECIFIER` from `root`. */
  readonly entry?: string;
}

/**
 * `undefined` when the app cannot resolve realtime's worker: an app with no realtime has no
 * socket to share, and the tab-side host falls back to an in-page engine by design (slice 11's
 * transparent fallback) — absence is an answer, not a failure.
 */
export function buildSyncWorker(
  root: string,
  options: BuildSyncWorkerOptions = {},
): Promise<FrameworkScript | undefined> {
  return buildFrameworkScript(
    root,
    'sync worker',
    SYNC_WORKER_SPECIFIER,
    SYNC_WORKER_BASE_PATH,
    options.entry,
  );
}

/**
 * The page boot, or `undefined` for an app with no realtime (nothing to restore, no outbox). A
 * document then carries no boot script, and `pageRealtime().booted` answers at once.
 */
export function buildPageBoot(
  root: string,
  options: BuildSyncWorkerOptions = {},
): Promise<FrameworkScript | undefined> {
  return buildFrameworkScript(
    root,
    'page boot',
    PAGE_BOOT_SPECIFIER,
    PAGE_BOOT_BASE_PATH,
    options.entry,
  );
}

async function buildFrameworkScript(
  root: string,
  what: FrameworkScriptKind,
  specifier: string,
  basePath: string,
  explicit: string | undefined,
): Promise<FrameworkScript | undefined> {
  const entry = explicit ?? resolveEntry(root, specifier);
  if (entry === undefined) return undefined;
  const label = relative(root, entry);
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      // A CLASSIC script: `new SharedWorker(url, { name })` with no `type: 'module'` runs it, and a
      // `<script defer>` runs it before any island module that follows it in the document.
      format: 'iife',
      splitting: false,
      minify: true,
      // `island-bundle.ts`'s reasons, verbatim: a chunk is only ever built to be shipped, and the
      // map's `sourcesContent` is the one stable identity a minified bundle has.
      define: { 'process.env.NODE_ENV': '"production"' },
      sourcemap: 'external',
    });
  } catch (error) {
    throw new FrameworkScriptBuildFailedError({
      what,
      entry: label,
      logs: describeBuildError(error),
    });
  }
  const output = built.outputs.find((artifact) => artifact.kind === 'entry-point');
  const map = built.outputs.find((artifact) => artifact.kind === 'sourcemap');
  if (!built.success || output === undefined || map === undefined) {
    throw new FrameworkScriptBuildFailedError({
      what,
      entry: label,
      logs: built.logs.map((log) => String(log)).join('; '),
    });
  }
  const code = stripDebugId(await output.text());
  return {
    url: `${basePath}/${graphHash(specifier, await map.text())}.js`,
    code,
    bytes: new TextEncoder().encode(code).byteLength,
  };
}

/**
 * The app's realtime, from the root or — in a workspace app, where `@ultimat3/realtime` is a
 * dependency of `apps/<app>` and not of the root (`examples/dummy`) — from the first app that has
 * it: where its islands resolve it, which is the copy the scripts must match. Resolving from the
 * root alone built no worker and no boot for such an app, silently.
 */
function resolveEntry(root: string, specifier: string): string | undefined {
  for (const dir of [root, ...appDirs(root)]) {
    try {
      return Bun.resolveSync(specifier, dir);
    } catch {
      // Not installed here, or a realtime that predates the export: try the next app.
    }
  }
  return undefined;
}

function appDirs(root: string): readonly string[] {
  const glob = new Bun.Glob('apps/*/package.json');
  return [...glob.scanSync({ cwd: root, onlyFiles: true })]
    .sort()
    .map((file) => join(root, dirname(file)));
}

/** The script a build produced, read per request so `x dev` and the container share one route. */
export type SyncWorkerSource = () => FrameworkScript | undefined;

export function syncWorkerRoutes(source: SyncWorkerSource): readonly Route[] {
  return [scriptRoute(SYNC_WORKER_BASE_PATH, 'assets.sync-worker', 'sync worker', source)];
}

export function pageBootRoutes(source: SyncWorkerSource): readonly Route[] {
  return [scriptRoute(PAGE_BOOT_BASE_PATH, 'assets.page-boot', 'page boot', source)];
}

function scriptRoute(
  basePath: string,
  name: string,
  what: string,
  source: SyncWorkerSource,
): Route {
  return {
    method: 'GET',
    path: `${basePath}/:file`,
    meta: { name, auth: 'public', tags: ['assets'] },
    handler: (request: UltimateRequest): Response => {
      const script = source();
      if (script === undefined || script.url !== request.pathname) {
        return json(
          {
            ok: false,
            error: {
              code: 'X_ROUTE_NOT_FOUND',
              cause: `no ${what} is built at ${request.pathname} — the document that named it was rendered against another build`,
              fix: `reload the page — this process serves only the ${what} it built`,
            },
          },
          { status: 404 },
        );
      }
      return applyCacheHeaders(
        new Response(script.code, { headers: { 'content-type': 'text/javascript' } }),
        { mode: 'immutable' },
      );
    },
  };
}
