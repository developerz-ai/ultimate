// One route's document: the head a route and the app decide together, the body inside the
// hydration root, and the assembly of the two. Split from `runtime-render.ts`, which owns picking a
// mode and answering with what it rendered; every mode's document is built here, once.

import { actionPathStyle } from '@ultimat3/action';
import { escapeHtml } from '@ultimat3/core';
import type { RouteParams } from '@ultimat3/http';
import { currentLocale } from '@ultimat3/i18n';
import type { IslandCollector, RouteData, RouteEntry } from '@ultimat3/render';
import {
  clientPathStyleTags,
  clientPersistTags,
  clientPinTags,
  clientScopeTag,
  clientSyncTags,
  headFromMeta,
  hydrateRuntime,
  metaContextFor,
  renderHead,
  seoRenderers,
} from '@ultimat3/render';
import type { HoleSink } from '@ultimat3/render/server';
import { ROOT_ELEMENT_ID, renderComponent } from '@ultimat3/render/server';
import { loadAppConfig } from './app-config-load';
import type { DocumentOptions } from './document-options';
import { routeQuery } from './isr-query-guard';
import { navigationTagsOf } from './page-navigation';
import { servedPins } from './page-pins';
import { bootScript, collectorFor } from './route-islands';
import { siteAssetTable } from './site-assets';
import { styleBundle } from './style-bundle';

/**
 * The app-wide favicon head, from `site.favicon`: the content-hashed URL `asset('assets/….svg')`
 * returns and `/assets/*` serves, never the raw path. Per render, never frozen at boot.
 */
export async function appFaviconHead(root: string): Promise<string | undefined> {
  const favicon = (await loadAppConfig(root))?.site.favicon;
  if (favicon === undefined) return undefined;
  const url = siteAssetTable(root).resolve(favicon).url;
  return `<link rel="icon" type="image/svg+xml" href="${escapeHtml(url)}">`;
}

/** `DocumentOptions`, plus the app root the app's own favicon is resolved against per render. */
export type RenderOptions = DocumentOptions & { readonly root?: string };

/** What a route's `meta(data)` is given. `url` is a string because that is what `ld.*` embeds. */
export interface DevRouteData extends Record<string, unknown> {
  readonly url: string;
  readonly params: RouteParams;
}
/**
 * `<html lang>` is the request's own locale, never a constant: the `locale` stage negotiated it
 * one stage before this handler and published it on the context, so a hardcoded `'en'` shipped
 * every document mislabelled — wrong for a screen reader, wrong for `hreflang`. Outside a request
 * (`x build`'s prerender) it is the app's own configured fallback.
 */
export const lang = (): string => currentLocale();

/**
 * `scope` is present only on a PRIVATE document (a gated `ssr` page, every `stream`): the page's
 * client scope (`@ultimat3/auth`'s `clientScopeOf`), which core's `pageClient()` reads to fence its
 * one store per principal. A shareable document carries NO scope tag — absent means "not rendered
 * for anyone", a different answer from `''`, the anonymous page.
 */
export const headFor = async (
  entry: RouteEntry,
  ctx: DevRouteData,
  data: RouteData,
  options: RenderOptions,
  scope?: string,
): Promise<string> => {
  const meta = metaContextFor(ctx, data);
  const url = new URL(ctx.url);
  const router = navigationTagsOf(options.navigation, entry, meta.t);
  return (
    renderHead(
      headFromMeta(
        await entry.config.meta(meta),
        seoRenderers({
          path: url.pathname,
          baseUrl: options.origin ?? url.origin,
          // The default is the cluster's own head (`alternates` is default-first by contract), so
          // `x-default` comes from the list the hreflang tags do — never a second locale read.
          localization: {
            locale: meta.locale,
            defaultLocale: meta.alternates[0]?.locale ?? meta.locale,
            alternates: meta.alternates,
          },
        }),
        [
          ...(options.sync === undefined ? [] : clientSyncTags(options.sync)),
          // Every document, shareable ones included: the style is the app's, not a visitor's, and
          // it is the only way an island's `rpc()` learns it. Read per render — `defineApi` may run
          // after these routes are built. `'resource'`, the default, is no tag.
          ...clientPathStyleTags(actionPathStyle()),
          // Same reason, same read: a pinned action or query is reached by NAME from the browser
          // (`rpc`, `useQuery`, `useMutation`) only through this. Nothing pinned is no tag.
          ...clientPinTags(servedPins()),
          ...router,
          // The page boot rides the scope tag: its whole job — restoring a principal's persisted
          // records and replaying its queued writes — is per principal, and a shareable document
          // (no scope tag) has neither.
          ...(scope === undefined
            ? []
            : [clientScopeTag(scope), ...clientPersistTags(options.persisted?.() ?? [])]),
        ],
      ),
    ) +
    (options.themeHead ?? '') +
    // One mechanism per document: the router prefetches for itself, the browser for the rest.
    (router.length === 0 ? (options.speculationHead ?? '') : '') +
    // The app's own favicon: one link, every document, the URL the table resolves NOW.
    ((options.root === undefined ? options.faviconHead : await appFaviconHead(options.root)) ??
      '') +
    // Per locale: each links its own locale's manifest (`PwaArtifacts.headFor`).
    (typeof options.pwaHead === 'function'
      ? options.pwaHead(meta.locale)
      : (options.pwaHead ?? '')) +
    (entry.surface === 'app' ? (options.appHead ?? '') : '')
  );
};

/**
 * `<link rel="stylesheet">` for the surface's own stylesheets, or nothing at all when the surface
 * imports none.
 *
 * In `<head>`, which is what keeps this a swap and not a regression: a `<link rel="stylesheet">`
 * there is render-blocking in every browser, exactly as the inline block was, so there is no window
 * in which the document paints unstyled. Moving it to the body, or deferring it, would introduce a
 * flash — never do that here.
 *
 * Read through `styleBundle()` rather than passed in through `DocumentOptions`: the registry it
 * derives from is process-global (importing the app IS what fills it), so a caller that forgot to
 * thread a resolver would serve a document with no CSS at all. One reader, and it is the same one
 * `styleRoutes` serves from.
 */
const styleTag = (entry: RouteEntry): string => {
  const href = styleBundle().hrefFor(entry.surface);
  return href === undefined ? '' : `<link rel="stylesheet" href="${href}">`;
};

/** The surface stylesheet, then the app's brand — the order that lets the brand win the cascade. */
export const stylesFor = (entry: RouteEntry, options: DocumentOptions): string =>
  styleTag(entry) + (options.brandHead ?? '');

/**
 * The route's rendered body, inside the hydration root. Every mode goes through here — an empty
 * root is what a module exporting no component renders, and nothing else: `spa` was the one mode
 * that never reached this function, so every `spa` route ever declared served an empty root.
 */
export async function routeBody(
  entry: RouteEntry,
  ctx: DevRouteData,
  data: RouteData,
  islands: IslandCollector,
  // Only the `stream` branch passes one. Absent, a `<Hole>` is its children, inline.
  holes?: HoleSink,
): Promise<string> {
  if (entry.component === undefined) return `<div id="${ROOT_ELEMENT_ID}"></div>`;
  const url = new URL(ctx.url);
  const html = await renderComponent(
    entry.component,
    // `data` is the route's own `load` result and is what `meta` was just given — the same object,
    // never a second resolution. `query` is supplied because a page that reads `props.query.x`
    // otherwise dereferences undefined and takes the whole render down.
    {
      data,
      params: ctx.params,
      url: ctx.url,
      query: routeQuery(entry, url),
    },
    entry.file,
    holes === undefined ? { islands } : { islands, holes },
  );
  return `<div id="${ROOT_ELEMENT_ID}">${html}</div>`;
}

/**
 * The document from data ALREADY resolved. Split from `routeDocument` so one request resolves
 * `load` exactly once: `stream` renders head and body separately, and resolving in each would let
 * a `<title>` describe content the body does not contain.
 *
 * The hydration runtime is appended after the body and only after it: what strategies a page needs
 * is a fact about the islands the walk just recorded, so emitting it earlier would guess or ship
 * the whole runtime to a page with no island.
 */
export async function documentFrom(
  entry: RouteEntry,
  ctx: DevRouteData,
  data: RouteData,
  options: RenderOptions,
  scope?: string,
): Promise<string> {
  const islands = collectorFor(entry, options, scope);
  const [head, body] = await Promise.all([
    headFor(entry, ctx, data, options, scope),
    routeBody(entry, ctx, data, islands),
  ]);
  return (
    `<!doctype html><html lang="${lang()}"><head>${head}${stylesFor(entry, options)}</head>` +
    `<body>${body}${bootScript(entry, islands, options, scope)}${hydrateRuntime(islands.directives)}</body></html>`
  );
}
