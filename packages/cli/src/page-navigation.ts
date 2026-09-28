// The client router a document may carry, composed ONCE for `x dev`, the container and the static
// export: which surfaces opted in (`navigation: { client: [...] }` in `app.config.ts`), the router
// script built from the app's own `@ultimat3/render`, its route, the head a document of an opted-in
// surface carries, and the SERVER's half per page — which router may swap it in, whether it may be
// prefetched (`@ultimat3/http`'s navigation gate reads that off the route meta), and the principal
// check a soft visit gets before `load`. No surface opted in: nothing is built, served or named — a
// `site/` page that did not ask stays 0kb (axiom 6).

// why: Bun exposes no path-join primitive, and the config path is app-root-relative — the same
// necessity `theme-boot.ts` records.
import { join } from 'node:path';
import { clientScopeOf } from '@ultimat3/auth';
import type { Ctx, NavigationSurface } from '@ultimat3/core';
import { CLIENT_NAVIGATION_SCOPE_HEADER, NAVIGATION_SURFACES } from '@ultimat3/core';
import type { Route, RouteNavigation, UltimateRequest } from '@ultimat3/http';
import { navigationPurpose, relocate } from '@ultimat3/http';
import type { ClientNavigationHead, HeadTag, RouteEntry } from '@ultimat3/render';
import {
  clientNavigationTags,
  documentCarriesScope,
  RouteNavigationInvalidError,
  routeEntries,
} from '@ultimat3/render';
import { ssrHeaders } from '@ultimat3/render/server';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';
import { FrameworkScriptBuildFailedError } from './errors';
import {
  buildNavigationScript,
  type FrameworkScript,
  NAVIGATION_SPECIFIER,
  navigationRoutes,
} from './worker-bundle';

/** What a document renderer needs to decide, per route, whether to name the router. */
export interface NavigationDocumentHead {
  readonly surfaces: ReadonlySet<string>;
  readonly scriptUrl: string;
  /** The skew check's reference: a soft navigation onto another build is a full load. */
  readonly buildId: string;
  /** `app.config.ts`'s `name`: two apps on one origin (web and admin) are two routers. */
  readonly app: string;
}

export interface PageNavigation {
  readonly routes: readonly Route[];
  /** The router script, for the static export to write and the service worker to precache. */
  readonly script: FrameworkScript | undefined;
  /** `undefined` when no surface opted in. */
  readonly head: NavigationDocumentHead | undefined;
}

/** `app.config.ts`'s answer: the app's name and the surfaces that opted in. */
export interface NavigationDeclaration {
  readonly app: string;
  readonly surfaces: readonly NavigationSurface[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isSurface = (value: unknown): value is NavigationSurface =>
  NAVIGATION_SURFACES.some((surface) => surface === value);

/**
 * `navigation.client` and `name`, as `defineConfig` validated them — no surfaces when the app says
 * nothing or has no config file. Structural, never `instanceof`, for `loadThemeMode`'s reason.
 */
export async function loadNavigation(root: string): Promise<NavigationDeclaration> {
  const configPath = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(configPath).exists())) return { app: 'app', surfaces: [] };
  const module = (await import(configPath)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  if (!isRecord(config)) return { app: 'app', surfaces: [] };
  const app = typeof config['name'] === 'string' ? config['name'] : 'app';
  const navigation = config['navigation'];
  const client = isRecord(navigation) ? navigation['client'] : undefined;
  return { app, surfaces: Array.isArray(client) ? client.filter(isSurface) : [] };
}

/**
 * A page declaring `navigation` on a surface with no client navigation says something no process
 * can honour — refused at boot, before a single request, for every route in the table.
 */
export function assertRouteNavigation(
  surfaces: readonly NavigationSurface[],
  entries: readonly RouteEntry[] = routeEntries(),
): void {
  for (const entry of entries) {
    const mode = entry.config.navigation;
    if (mode === undefined || surfaces.some((surface) => surface === entry.surface)) continue;
    throw new RouteNavigationInvalidError(
      `${entry.file} declares navigation: '${mode}', and its surface (${entry.surface}) is not in app.config.ts navigation.client`,
    );
  }
}

/**
 * Built at boot, never on the watcher tick — the router is framework code, and a tab that loaded
 * it keeps it across every soft navigation, so a URL that changed per save would be one no tab
 * asks for again.
 */
export async function pageNavigation(
  root: string,
  declared: NavigationDeclaration,
  buildId: string,
): Promise<PageNavigation> {
  assertRouteNavigation(declared.surfaces);
  if (declared.surfaces.length === 0) return { routes: [], script: undefined, head: undefined };
  const script = await buildNavigationScript(root);
  // Opted in and nothing to build is a refusal, never a silent full-page app: the app asked for a
  // behaviour and would otherwise ship without it and without a word.
  if (script === undefined) {
    throw new FrameworkScriptBuildFailedError({
      what: 'client router',
      entry: NAVIGATION_SPECIFIER,
      logs: `${NAVIGATION_SPECIFIER} does not resolve from ${root} — install @ultimat3/render at the version of @ultimat3/cli`,
    });
  }
  return {
    routes: navigationRoutes(() => script),
    script,
    head: {
      surfaces: new Set(declared.surfaces),
      scriptUrl: script.url,
      buildId,
      app: declared.app,
    },
  };
}

/** `<app>:<surface>` — what the document says and what the route meta requires. */
export const surfaceKey = (head: NavigationDocumentHead, surface: string): string =>
  `${head.app}:${surface}`;

/** The head for one document, or `undefined` when its surface did not opt in. */
export function navigationHeadFor(
  head: NavigationDocumentHead | undefined,
  surface: string,
): ClientNavigationHead | undefined {
  if (head === undefined || !head.surfaces.has(surface)) return undefined;
  return { surface: surfaceKey(head, surface), buildId: head.buildId, scriptUrl: head.scriptUrl };
}

/**
 * The router's meta, build and script — only on a page of a surface that opted in, and never on a
 * `navigation: 'document'` page. That page is a document by declaration: every link to it is a real
 * load, and it is where an app puts a 0 kB page (a recipient's evidence page, a magic link, an
 * unsubscribe, a payment return — `budget.js: '0b'`, `hydrate: 'never'`). With no router on it, its
 * own links and forms are the browser's, which is what a document page means; `budgets.ts` weighs
 * the emitted document, so a page that names no router is charged none.
 */
export function navigationTagsOf(
  head: NavigationDocumentHead | undefined,
  entry: Pick<RouteEntry, 'surface' | 'config'>,
): readonly HeadTag[] {
  if (entry.config.navigation === 'document') return [];
  const tags = navigationHeadFor(head, entry.surface);
  return tags === undefined ? [] : clientNavigationTags(tags);
}

/** `{ navigation }` for `metaOf`'s spread, or nothing. */
export function navigationMetaOf(
  entry: RouteEntry,
  head: NavigationDocumentHead | undefined,
): { readonly navigation?: RouteNavigation } {
  const navigation = routeNavigationOf(entry, head);
  return navigation === undefined ? {} : { navigation };
}

/**
 * The route meta `@ultimat3/http`'s gate reads: present only for a page the router may swap in.
 * `navigation: 'document'` and every page of a surface that did not opt in get none — so a
 * router request to them runs nothing and is handed to the browser.
 */
export function routeNavigationOf(
  entry: RouteEntry,
  head: NavigationDocumentHead | undefined,
): RouteNavigation | undefined {
  if (head === undefined || !head.surfaces.has(entry.surface)) return undefined;
  if (entry.config.navigation === 'document') return undefined;
  return {
    surface: surfaceKey(head, entry.surface),
    prefetch: entry.config.navigation === 'prefetch',
  };
}

/**
 * The principal this page's document will be rendered for — `null` for a shareable document, which
 * carries no scope — by the rule `resultFor` renders by: every `stream` and every gated `ssr`.
 */
function scopeOf(entry: RouteEntry, ctx: Ctx, buildId: string): string | null {
  const render = entry.config.render;
  const scoped =
    render === 'stream' ||
    (render === 'ssr' && documentCarriesScope(ssrHeaders(entry, { buildId })));
  return scoped ? clientScopeOf(ctx.actor) : null;
}

/**
 * A soft visit to a page rendered for a principal other than the one the router's document was:
 * the page boot restores and fences ONE principal per load, so it must be a real load — answered
 * here, before `load` runs, so the page runs once (for that load) and never for a swap discarded.
 */
export function principalRelocation(
  entry: RouteEntry,
  request: UltimateRequest,
  ctx: Ctx,
  buildId: string,
): Response | undefined {
  if (navigationPurpose(request.raw) === null) return undefined;
  const said = request.header(CLIENT_NAVIGATION_SCOPE_HEADER);
  return said === scopeOf(entry, ctx, buildId) ? undefined : relocate(request.url.href);
}
