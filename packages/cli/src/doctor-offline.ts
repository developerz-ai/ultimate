// `x doctor`'s offline-fallback check: the path the app DECLARED, against the routes it really
// serves. Its own file because answering it needs the app's config and its route table, and
// `cmd-doctor.ts`'s job is the probe rather than the loading — the `db-backfill.ts` split, one
// diagnostic over.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { describeRoutes } from '@ultimat3/render';
import { loadApp } from './app-load';
import { APP_CONFIG_FILE } from './app-root';
import type { Finding } from './output';
import { loadPwaArtifacts } from './pwa-artifacts';

/** A route as this check reads one: the URL it answers, and the surface that answers it. */
export interface NavigableRoute {
  readonly path: string;
  readonly surface: string;
}

export interface OfflineFallbackFact {
  /**
   * `pwa.offline.fallback` as `loadPwaArtifacts` read it, or `null` — which is both "this app
   * declares no PWA" and "it declares one with no fallback". Either way no service worker is
   * emitted at all (`serviceWorkerArtifacts` answers `undefined`), so the two share one remedy.
   */
  readonly fallback: string | null;
  /**
   * Every registered route, or `undefined` when the app would not load. `appEntities`' rule
   * (`schema-drift.ts`) one registry over: a module that will not import leaves the registry
   * short, and a short registry reads as "no route serves it" — a generator handed out for a route
   * the app already has, over one file's syntax error.
   */
  readonly routes: readonly NavigableRoute[] | undefined;
}

/**
 * The two surfaces a navigation can land on. An `api/` route answers a JSON document and `shared/`
 * is not a URL at all, which is the same pair `sw-artifacts.ts` keeps for the same reason.
 */
const NAVIGABLE: ReadonlySet<string> = new Set(['site', 'app']);

/**
 * A fallback `x g route <name> --surface site` can actually create: ONE path segment, which is
 * what the generator turns into `apps/<app>/site/<name>/page.tsx` and therefore into `/<name>`. A
 * nested or punctuated path would be slugified into a DIFFERENT url (`/support/offline` →
 * `/support-offline`), so offering the command there is a fix that runs and leaves the finding
 * exactly where it was.
 *
 * `--surface site`, and never `app`: the document that answers a lost network must render with no
 * network, no session and no database, which `app/` (`ssr | stream`) cannot promise — the reason
 * `x new` scaffolds it under `site/` (`wiki/Upgrading.md`) — and it is the line `@ultimat3/pwa`'s
 * own `X_PWA_NO_OFFLINE_FALLBACK` hands out. Two fixes for one code are two answers.
 */
const GENERATABLE = /^\/([a-z][a-z0-9-]*)$/;

const finding = (cause: string, fix: string): Finding => ({
  code: 'X_PWA_NO_OFFLINE_FALLBACK',
  cause,
  fix,
  docs: ERROR_DOCS_URL,
  at: APP_CONFIG_FILE,
});

/**
 * The declared fallback, judged against the route table — never against a filename.
 *
 * It WAS a filename: the literal `apps/web/app/offline.tsx`, which `assertRouteFilename` refuses
 * outright (the directory is the URL, so a page is `page.tsx`), while `x new` scaffolds
 * `apps/web/site/offline/page.tsx` and this finding's own `fix:` writes
 * `apps/web/app/offline/page.tsx`. Every one of the three is a different path, so the check was
 * red for every app the framework has ever produced and no invocation could clear it — the shape
 * `budgets.ts` calls a false green read backwards, and the reason a diagnostic is held to being
 * closable by its own fix.
 */
export function offlineFallbackFinding(fact: OfflineFallbackFact): Finding | undefined {
  if (fact.routes === undefined) return undefined;
  const fallback = fact.fallback;
  if (fallback === null) {
    return finding(
      'no pwa.offline.fallback is declared, so no service worker is emitted and an offline navigation falls back to the browser error page',
      `set pwa: { offline: { fallback: '/offline' } } in ${APP_CONFIG_FILE}`,
    );
  }
  if (fact.routes.some((route) => route.path === fallback && NAVIGABLE.has(route.surface))) {
    return undefined;
  }
  const cause = `pwa.offline.fallback is "${fallback}" and no site/ or app/ route serves it, so an offline navigation falls back to the browser error page`;
  const name = GENERATABLE.exec(fallback)?.[1];
  return name === undefined
    ? finding(cause, `set pwa.offline.fallback in ${APP_CONFIG_FILE} to a path a route serves`)
    : finding(cause, `x g route ${name} --surface site`);
}

/**
 * The fact, read off a real app root. Both halves come from the framework's own answers — the
 * config through `loadPwaArtifacts` (the one reader of that file) and the routes through
 * `describeRoutes()` (the projection `x.manifest.json`, `/_x`, the sitemap and `sw.js` are all
 * built from), so this check and the service worker cannot disagree about which routes exist.
 */
export async function offlineFallbackProbe(root: string): Promise<OfflineFallbackFact> {
  const pwa = await loadPwaArtifacts(root);
  const app = await loadApp(root);
  return {
    fallback: pwa?.offline.fallback ?? null,
    routes:
      app.findings.length > 0
        ? undefined
        : describeRoutes().map((route) => ({ path: route.path, surface: route.surface })),
  };
}
