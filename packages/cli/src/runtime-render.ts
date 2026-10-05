// Projecting the route table onto HTTP routes both boots serve. Every mode goes through
// `@ultimat3/render`'s own function for that mode — the CLI picks the mode and supplies the
// document (head + the route's component, the surface's CSS LINKED, `style-bundle.ts`), it never
// decides what a mode means or what headers it earns.

import { actionPathStyle } from '@ultimat3/action';
import { clientScopeOf } from '@ultimat3/auth';
import type { Ctx } from '@ultimat3/core';
import { CLIENT_SCOPE_HEADER, createSingleFlight } from '@ultimat3/core';
import type {
  RouteMeta as HttpRouteMeta,
  RedirectIntent,
  RequestContext,
  Route,
  RouteParams,
  UltimateRequest,
} from '@ultimat3/http';
import { asCtx, html, NO_STORE, redirect, stream, takeRedirect } from '@ultimat3/http';
import { currentLocale, localeConfig } from '@ultimat3/i18n';
import type { IslandCollector, RenderResult, RouteData, RouteEntry } from '@ultimat3/render';
import {
  clientPathStyleTags,
  clientPersistTags,
  clientScopeTag,
  clientSyncTags,
  documentCarriesScope,
  headFromMeta,
  hydrateRuntime,
  metaContextFor,
  renderHead,
  routeDataFor,
  routeEntries,
  routeFor,
  routeStatusOf,
  seoRenderers,
} from '@ultimat3/render';
import type { IsrController } from '@ultimat3/render/server';
import {
  contentHash,
  isrKey,
  ROOT_ELEMENT_ID,
  renderComponent,
  renderSsr,
  ssrHeaders,
  staticHeaders,
  streamResult,
} from '@ultimat3/render/server';
import type { DocumentOptions } from './document-options';
import {
  type NavigationDocumentHead,
  navigationMetaOf,
  navigationTagsOf,
  principalRelocation,
} from './page-navigation';
import { bootScript, collectorFor } from './route-islands';
import { attachedIsr } from './runtime-isr';
import type { StaticResult } from './static-document';
import { createStaticMemo, staticMemoKey, staticResponse } from './static-document';
import { styleBundle } from './style-bundle';

export type { DocumentOptions, IslandResolver } from './document-options';

export interface DevRenderOptions extends DocumentOptions {
  readonly buildId: string;
  /**
   * The boot's own controller, attached and released by it (`runtime-isr.ts`). Omitted, one is
   * built AND attached here, never released — a caller with no stop list (a contract test) still
   * gets pages a tag bust reaches; the revalidator slot is the latest attach's.
   */
  readonly isr?: IsrController;
  /**
   * Keep each `static` document after its first render (`static-document.ts`). The container sets
   * it; `x dev` never does — a save changes the page, its stylesheet's URL and its islands'.
   */
  readonly memoStatic?: boolean;
}

/** What a route's `meta(data)` is given. `url` is a string because that is what `ld.*` embeds. */
export interface DevRouteData extends Record<string, unknown> {
  readonly url: string;
  readonly params: RouteParams;
}

/**
 * `<html lang>` is the request's own locale, never a constant: the `locale` stage negotiated it
 * one stage before this handler and published it on the context, so a hardcoded `'en'` shipped
 * every document mislabelled — wrong for a screen reader, wrong for `hreflang`, wrong for a CDN
 * keying on `content-language`. Outside a request (`x build`'s prerender) it is the app's own
 * configured fallback, which is the only defensible answer there.
 */
const lang = (): string => currentLocale();

/**
 * `scope` is present only on a PRIVATE document (a gated `ssr` page, every `stream`): the page's
 * client scope (`@ultimat3/auth`'s `clientScopeOf`), which core's `pageClient()` reads to fence its
 * one store per principal. A shareable document (`static`, `isr`, ungated `ssr`) carries NO scope
 * tag — absent means "not rendered for anyone", a different answer from `''`, the anonymous page.
 */
const headFor = async (
  entry: RouteEntry,
  ctx: DevRouteData,
  data: RouteData,
  options: DocumentOptions,
  scope?: string,
): Promise<string> => {
  const meta = metaContextFor(ctx, data);
  const url = new URL(ctx.url);
  const router = navigationTagsOf(options.navigation, entry);
  return (
    renderHead(
      headFromMeta(
        await entry.config.meta(meta),
        seoRenderers({
          path: url.pathname,
          baseUrl: options.origin ?? url.origin,
          localization: {
            locale: meta.locale,
            defaultLocale: localeConfig().fallback,
            alternates: meta.alternates,
          },
        }),
        [
          ...(options.sync === undefined ? [] : clientSyncTags(options.sync)),
          // Every document, shareable ones included: the style is the app's, not a visitor's, and
          // it is the only way an island's `rpc()` learns it. Read per render — `defineApi` may run
          // after these routes are built. `'resource'`, the default, is no tag.
          ...clientPathStyleTags(actionPathStyle()),
          ...router,
          // The page boot rides the scope tag: its whole job — restoring a principal's persisted
          // records and replaying its queued writes — is per principal, and a shareable document
          // (no scope tag) has neither. Cheaper than walking the page's islands, and exact.
          ...(scope === undefined
            ? []
            : [clientScopeTag(scope), ...clientPersistTags(options.persisted?.() ?? [])]),
        ],
      ),
    ) +
    (options.themeHead ?? '') +
    // One mechanism per document: the router prefetches for itself, the browser for the rest.
    (router.length === 0 ? (options.speculationHead ?? '') : '') +
    // Per locale: each links its own locale's manifest (`PwaArtifacts.headFor`).
    (typeof options.pwaHead === 'function' ? options.pwaHead(meta.locale) : (options.pwaHead ?? ''))
  );
};

/**
 * `<link rel="stylesheet">` for the surface's own stylesheets, or nothing at all when the surface
 * imports none. Inlined until 2026-09-06: every `app/` document of ai-maxxing then carried the same
 * 156,738-byte `<style>` (92% of it) under `no-store`, re-paid on every navigation.
 *
 * In `<head>`, which is what keeps this a swap and not a regression: a `<link rel="stylesheet">`
 * there is render-blocking in every browser, exactly as the inline block was, so there is no
 * window in which the document paints unstyled. Moving it to the body, or deferring it, is what
 * would introduce a flash — never do that here.
 *
 * Read through `styleBundle()` rather than passed in through `DocumentOptions`: the registry it
 * derives from is process-global (importing the app IS what fills it), so a caller that forgot to
 * thread a resolver would serve a document with no CSS at all — and `appRoutes` is on this
 * package's public surface, called as `appRoutes({ buildId })` by both tracked apps' contract
 * tests. One reader, and it is the same one `styleRoutes` serves from.
 */
const styleTag = (entry: RouteEntry): string => {
  const href = styleBundle().hrefFor(entry.surface);
  return href === undefined ? '' : `<link rel="stylesheet" href="${href}">`;
};

/**
 * The route's rendered body, inside the hydration root. Every mode goes through here — an empty
 * root is what a module exporting no component renders, and nothing else: `spa` was the one mode
 * that never reached this function, which is why every `spa` route ever declared served
 * `<div id="x-root"></div>` and painted nothing.
 */
export async function routeBody(
  entry: RouteEntry,
  ctx: DevRouteData,
  data: RouteData,
  islands: IslandCollector,
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
      query: Object.fromEntries(url.searchParams) as Readonly<Record<string, string>>,
    },
    entry.file,
    { islands },
  );
  return `<div id="${ROOT_ELEMENT_ID}">${html}</div>`;
}

/**
 * Head + body for one route render. Exported because the build's prerenderer must emit the same
 * document `x dev` serves — two document builders is how a page that works in dev ships broken.
 */
export async function routeDocument(
  entry: RouteEntry,
  ctx: DevRouteData,
  options: DocumentOptions = {},
): Promise<string> {
  return documentFrom(entry, ctx, await routeDataFor(entry.config, ctx), options);
}

/**
 * The document from data ALREADY resolved. Split from `routeDocument` so one request resolves
 * `load` exactly once: `stream` renders head and body separately, and resolving in each would let
 * a `<title>` describe content the body does not contain.
 *
 * The hydration runtime is appended after the body and only after it: what strategies a page needs
 * is a fact about the islands the walk just recorded, so emitting it earlier would either guess or
 * ship the whole runtime to a page with no island — the 0kb baseline, spent on nothing.
 */
async function documentFrom(
  entry: RouteEntry,
  ctx: DevRouteData,
  data: RouteData,
  options: DocumentOptions,
  scope?: string,
): Promise<string> {
  const islands = collectorFor(entry, options);
  const [head, body] = await Promise.all([
    headFor(entry, ctx, data, options, scope),
    routeBody(entry, ctx, data, islands),
  ]);
  return (
    `<!doctype html><html lang="${lang()}"><head>${head}${styleTag(entry)}</head>` +
    `<body>${body}${bootScript(entry, islands, options, scope)}${hydrateRuntime(islands.directives)}</body></html>`
  );
}

/** Every mode but `isr`, which `renderIsr` answers: its `load` runs only when the store misses. */
async function resultFor(
  entry: RouteEntry,
  request: DevRouteData,
  data: RouteData,
  options: DevRenderOptions,
  ctx: Ctx,
): Promise<RenderResult> {
  const url = new URL(request.url);
  // The status the loader answered through `withStatus`, 200 when it said nothing. Read once,
  // here, and handed to every mode: this file mints the `Response`, render owns the seam.
  const status = routeStatusOf(data);
  switch (entry.config.render) {
    case 'static': {
      // Not `renderStatic`: that enumerates every prerendered path for the build. A request
      // names exactly one, and it earns the same content-hashed headers.
      const body = await documentFrom(entry, request, data, options);
      return { status, headers: staticHeaders(contentHash(body), options.buildId), body };
    }
    case 'stream': {
      // The shell IS the component: nothing can yet mark a subtree as a hole. Solid's `Suspense`
      // is not the missing piece and never will be here — it calls `getContextId()`, which throws
      // outside a Solid renderer, and this package's JSX factory is inert by design. A hole marker
      // has to be the framework's own. Until it exists the first flush carries the whole body —
      // correct output, no streaming benefit.
      const islands = collectorFor(entry, options);
      const [head, shell] = await Promise.all([
        // A stream is always `private, no-store` (`streamResult`), so it always carries the scope.
        headFor(entry, request, data, options, clientScopeOf(ctx.actor)),
        routeBody(entry, request, data, islands),
      ]);
      return withScope(
        streamResult(
          {
            head: `<!doctype html><html lang="${lang()}"><head>${head}${styleTag(entry)}</head><body>`,
            // The runtime rides the first flush, with the shell it boots. A later chunk would leave
            // the window between flush one and the close with inert islands and no listeners on
            // them — which is exactly the first-click-lost failure `interaction` replay exists for.
            shell: `${shell}${bootScript(entry, islands, options, clientScopeOf(ctx.actor))}${hydrateRuntime(islands.directives)}`,
            holes: [],
          },
          { buildId: options.buildId },
          status,
        ),
        clientScopeOf(ctx.actor),
      );
    }
    default: {
      // Asked of the headers `renderSsr` is about to send: a gated page is private and carries the
      // scope; an ungated one is `public, s-maxage` and a CDN may hand it to anyone, so it carries
      // none — absent, which core reads as "not rendered for anyone", never as anonymous.
      const scope = documentCarriesScope(ssrHeaders(entry, { buildId: options.buildId }))
        ? clientScopeOf(ctx.actor)
        : undefined;
      return withScope(
        await renderSsr(
          { entry, params: request.params, url, ctx },
          () => documentFrom(entry, request, data, options, scope),
          { buildId: options.buildId, status },
        ),
        scope,
      );
    }
  }
}

/**
 * A private document's scope, as a RESPONSE header too: the service worker partitions its offline
 * pages by principal and never parses HTML, so the meta alone cannot reach it. Exactly the
 * documents that carry the scope tag carry this — a shareable one carries neither.
 */
const withScope = (result: RenderResult, scope: string | undefined): RenderResult =>
  scope === undefined
    ? result
    : { ...result, headers: { ...result.headers, [CLIENT_SCOPE_HEADER]: scope } };

/**
 * A loader's redirect. No declared `cache` means `private, no-store`: the loader decided it for
 * THIS request (it recorded an open, it checked a token), and the mode's default would offer that
 * decision to a CDN, which would then answer every later request without running the loader. A
 * declared one is the pipeline's to apply, off `meta.cache`, exactly as for any handler.
 */
function loadRedirect(entry: RouteEntry, to: RedirectIntent): Response {
  const response = redirect(to.location, to.status);
  if (entry.config.cache === undefined) response.headers.set('cache-control', 'private, no-store');
  return response;
}

const responseOf = (result: RenderResult): Response =>
  typeof result.body === 'string'
    ? html(result.body, { status: result.status, headers: result.headers })
    : stream(result.body, { status: result.status, headers: result.headers });

/** `auth` follows the route's own guard: a gated page is gated in dev by the production stage. */
const metaOf = (entry: RouteEntry, head?: NavigationDocumentHead): HttpRouteMeta => ({
  name: entry.file,
  auth: entry.config.policy === undefined ? 'public' : 'required',
  render: entry.config.render,
  tags: [entry.surface],
  // A `site/` page is prerendered once per locale and served as files, so its locale is its URL's:
  // the unprefixed path is the default, and the served process must answer what the file says.
  localeSource: entry.surface === 'site' ? 'path' : 'request',
  ...(entry.config.policy === undefined ? {} : { policy: entry.config.policy.permission }),
  // Projected so the router screens its ages at mount (`assertRouteCache`) and the `cache-headers`
  // stage applies it to a response that wrote none — a loader's redirect. The rendered document
  // carries its own header, from `ssrHeaders`, which the stage reviews rather than replaces.
  ...(entry.config.cache === undefined
    ? {}
    : { cache: entry.config.cache === 'no-store' ? NO_STORE : entry.config.cache }),
  // Which router may swap this page in, read by `@ultimat3/http`'s gate before anything runs.
  ...navigationMetaOf(entry, head),
});

/**
 * One HTTP route per registered `route` primitive, in the table's own order.
 *
 * The URL and the method are the table's at the time this is called; the ENTRY — the component the
 * handler renders AND the `meta` the pipeline enforces — is read back from the table on every
 * request. `x dev` re-registers a route module when its source changes (`app-load.ts`), and a
 * handler closing over the entry it was built from kept serving the first component after every
 * save — the table had moved and this closure had not. `meta` was the same defect one stage
 * earlier: a snapshot taken here, so a `policy` added in a save was not enforced until a restart
 * while the page behind it was already the new one — the pipeline's `auth` and `authz` stages read
 * `route.meta` per request, and this getter is what makes that read the table's. The path cannot
 * move under a reload (the table derives it from the file, and the file is the reload's key), so
 * the entry captured here is only the fallback for a table cleared under a running server, which
 * only a test does — and then guard and page fall back together.
 */
export function appRoutes(options: DevRenderOptions): readonly Route[] {
  const isr = options.isr ?? attachedIsr({ buildId: options.buildId }).isr;
  const memo = createStaticMemo();
  // A cold static key is ONE render however many requests arrive during it: the memo alone was
  // check-then-act, so a burst at boot ran `load` and the render once per request.
  const firstRender = createSingleFlight();
  return routeEntries().map((registered) => ({
    method: 'GET' as const,
    path: registered.path,
    get meta(): HttpRouteMeta {
      return metaOf(routeFor(registered.path) ?? registered, options.navigation);
    },
    // `ctx.params` is the router's own match — the CLI never re-parses a path it did not match.
    handler: async (request, ctx): Promise<Response> => {
      const entry = routeFor(registered.path) ?? registered;
      // A soft visit onto another principal's document is a real load — answered before `load`.
      const moved = principalRelocation(entry, request, asCtx(ctx), options.buildId);
      if (moved !== undefined) return moved;
      // A static page already rendered by this process is answered without `load` or a render.
      const key =
        options.memoStatic === true
          ? staticMemoKey(entry, request.url, asCtx(ctx).locale)
          : undefined;
      const kept = key === undefined ? undefined : memo.get(key);
      if (kept !== undefined) return staticResponse(request, kept);
      let led = false;
      const render = async (): Promise<Rendered> => {
        led = true;
        const rendered = await renderEntry(entry, request, ctx, options, isr);
        if (key !== undefined && rendered.document !== undefined) memo.set(key, rendered.document);
        return rendered;
      };
      const shared = key === undefined ? await render() : await firstRender.run(key, render);
      // Only a DOCUMENT is shared. A redirect `load` decided was its request's own, so a request
      // that joined one renders for itself rather than answer with another request's `Location`.
      const rendered = shared.document !== undefined || led ? shared : await render();
      // The ETag was only ever a header: a matching `If-None-Match` is a 304, not the page again.
      return rendered.document === undefined
        ? rendered.respond()
        : staticResponse(request, rendered.document);
    },
  }));
}

/** A static document a joined request can share, or how to answer when there is none. */
interface Rendered {
  readonly document?: StaticResult;
  readonly respond: () => Response;
}

async function renderEntry(
  entry: RouteEntry,
  request: UltimateRequest,
  ctx: RequestContext,
  options: DevRenderOptions,
  isr: IsrController,
): Promise<Rendered> {
  const data: DevRouteData = { url: request.url.href, params: ctx.params };
  if (entry.config.render === 'isr') return renderIsr(entry, data, ctx, options, isr);
  // ONCE per request, before the mode is chosen: every branch of `resultFor` reads this same
  // object, so a route's `load` runs exactly once however its mode splits head from body.
  const loaded = await routeDataFor(entry.config, data);
  // `setRedirect()` inside `load` — the same slot an action's handler fills — answers here,
  // before a document is rendered for a page the visitor is leaving. `withStatus` refuses a
  // 3xx because a rendered document has no `Location`; this is the path that has one.
  const to = takeRedirect(ctx);
  if (to !== undefined) return { respond: () => loadRedirect(entry, to) };
  const result = await resultFor(entry, data, loaded, options, asCtx(ctx));
  if (entry.config.render !== 'static' || typeof result.body !== 'string') {
    return { respond: () => responseOf(result) };
  }
  const document: StaticResult = { ...result, body: result.body };
  return { document, respond: () => responseOf(document) };
}

/**
 * Thrown out of an `isr` producer whose `load` redirected: a redirect is not a page, so nothing
 * may be stored for it, and the throw is what keeps `isr.serve` from storing one. Not an error —
 * the request it belongs to answers with the redirect.
 */
class IsrLoadRedirected {
  readonly reason = 'the isr load redirected, so no page was generated';
  constructor(readonly to: RedirectIntent) {}
}

/**
 * `isr`: a store hit is answered WITHOUT `load`. Resolving it before the mode choice, as every
 * other mode does, made each hit cost a full SSR's database work and kept only the HTML step
 * cached. So `load` and its redirect live inside the producer, which runs on a miss and on a
 * stale page's regeneration. A redirect drops whatever the store held for the key — a stale page
 * whose regeneration redirects is answered once more from the stale copy, then never again.
 */
async function renderIsr(
  entry: RouteEntry,
  data: DevRouteData,
  ctx: RequestContext,
  options: DevRenderOptions,
  isr: IsrController,
): Promise<Rendered> {
  // `isrKey(url, locale)`, never `url.pathname`: the query is part of what was rendered — `meta`
  // reads `data.url` — so two URLs differing only in their query are two documents (#171). The
  // locale is `ctx.locale`, the one the `locale` stage negotiated for THIS request.
  const key = isrKey(new URL(data.url), asCtx(ctx).locale);
  try {
    // `{ html, status }`, never the bare string: the entry stores the status beside the HTML and
    // serves it on every hit, so a 404 under `isr` is a 404 for its whole TTL.
    const served = await isr.serve(key, async () => {
      const loaded = await routeDataFor(entry.config, data);
      const to = takeRedirect(ctx);
      if (to !== undefined) {
        isr.store().delete(key);
        throw new IsrLoadRedirected(to);
      }
      const html = await documentFrom(entry, data, loaded, options);
      return { html, status: routeStatusOf(loaded) };
    });
    return { respond: () => responseOf(served.result) };
  } catch (thrown) {
    if (!(thrown instanceof IsrLoadRedirected)) throw thrown;
    const { to } = thrown;
    return { respond: () => loadRedirect(entry, to) };
  }
}
