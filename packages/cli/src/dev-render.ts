// Projecting the route table onto HTTP routes `x dev` can serve. Every mode goes through
// `@ultimat3/render`'s own function for that mode — the CLI picks the mode and supplies the
// document, it never decides what a mode means or what headers it earns.
//
// The document is head + the route's own component, rendered by `@ultimat3/render`'s server JSX
// writer, with the surface's compiled CSS LINKED — one content-hashed file per surface
// (`style-bundle.ts`), served `immutable`.
//
// It was inlined until 2026-09-06, on the argument that a `site/` page is a 0kb-JS artifact a CDN
// serves as one file and a link would add a round trip. The round trip is real and it is paid
// once: measured against ai-maxxing, every `app/` document carried the SAME 156,738-byte `<style>`
// block — 92% of the dashboard document — inside a response the pipeline sends
// `Cache-Control: private, no-store`, so the trip that argument saved was re-paid in full on every
// navigation, with a re-parse on top. The static export writes the file (`writeStyles`), so the
// "second file" cost is one `Bun.write`.

import type { Ctx } from '@ultimat3/core';
import type { RouteMeta as HttpRouteMeta, Route, RouteParams } from '@ultimat3/http';
import { asCtx, html, stream } from '@ultimat3/http';
import { currentLocale } from '@ultimat3/i18n';
import type { IslandCollector, RenderResult, RouteData, RouteEntry } from '@ultimat3/render';
import {
  createIslandCollector,
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
  createIsrController,
  isrKey,
  ROOT_ELEMENT_ID,
  renderComponent,
  renderSsr,
  staticHeaders,
  streamResult,
} from '@ultimat3/render/server';
import { styleBundle } from './style-bundle';

/**
 * Specifier → built chunk URL, bound to the route file the specifier is written relative to.
 * Supplied by whoever built the islands (`x dev`, the container, the static build); absent means
 * no island was built, and a page that renders one then fails by name rather than emitting a
 * `data-x-entry` nothing can import.
 */
export type IslandResolver = (routeFile: string) => (src: string) => string;

export interface DocumentOptions {
  readonly resolveIsland?: IslandResolver;
  /**
   * `<link rel="manifest">`, both `theme-color` metas and the apple-touch links — `PwaArtifacts.head`
   * from `pwa-artifacts.ts`, or absent when the app is not installable.
   *
   * A document-level string rather than something a route's `meta()` returns: it is the same three
   * elements on every page of the app, an installable app is one whose EVERY page carries them
   * (a browser offers the install on whichever page the visitor landed on), and `headFromMeta`
   * projects per-route SEO. Passed through `DocumentOptions` for `resolveIsland`'s reason — the
   * boot knows it, the renderer cannot ask.
   */
  readonly pwaHead?: string;
}

export interface DevRenderOptions extends DocumentOptions {
  readonly buildId: string;
  /** Injected so a test can drive the ISR store without a timer. */
  readonly isr?: IsrController;
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

const headFor = async (
  entry: RouteEntry,
  ctx: DevRouteData,
  data: RouteData,
  options: DocumentOptions,
): Promise<string> =>
  renderHead(
    headFromMeta(
      await entry.config.meta(metaContextFor(ctx, data)),
      seoRenderers({ path: new URL(ctx.url).pathname }),
    ),
  ) + (options.pwaHead ?? '');

/**
 * `<link rel="stylesheet">` for the surface's own stylesheets, or nothing at all when the surface
 * imports none.
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
 * One collector per RENDER, never module-global: two requests render different params, and a
 * shared collector would bill one page for the other's islands. `hydrate` comes off the route, so
 * an island never declares its own timing, and `resolve` is the build's — identity when nothing
 * built any, which fails at the first island by name rather than emitting an unusable entry.
 */
const collectorFor = (entry: RouteEntry, options: DocumentOptions): IslandCollector =>
  createIslandCollector({
    file: entry.file,
    hydrate: entry.config.hydrate,
    ...(options.resolveIsland === undefined ? {} : { resolve: options.resolveIsland(entry.file) }),
  });

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
): Promise<string> {
  const islands = collectorFor(entry, options);
  const [head, body] = await Promise.all([
    headFor(entry, ctx, data, options),
    routeBody(entry, ctx, data, islands),
  ]);
  return (
    `<!doctype html><html lang="${lang()}"><head>${head}${styleTag(entry)}</head>` +
    `<body>${body}${hydrateRuntime(islands.directives)}</body></html>`
  );
}

async function resultFor(
  entry: RouteEntry,
  request: DevRouteData,
  options: DevRenderOptions,
  isr: IsrController,
  ctx: Ctx,
): Promise<RenderResult> {
  const url = new URL(request.url);
  // ONCE per request, before the mode is chosen. Every branch below reads this same object, so a
  // route's `load` runs exactly once however its mode splits head from body.
  const data = await routeDataFor(entry.config, request);
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
    case 'isr': {
      // `isrKey(url, locale)`, never `url.pathname`: the query is part of what was rendered — this
      // route's own `meta` reads `data.url` — so two URLs differing only in their query are two
      // documents. Keyed on the pathname alone, the first render answered every later query
      // string (#171). Render owns the derivation so no second caller can invent another.
      // The locale is the second dimension and it is `ctx.locale`, the answer the `locale` stage
      // already negotiated for THIS request — never `currentLocale()`, which would read the same
      // value through an ambient store the key does not need.
      // `{ html, status }`, never the bare string: the entry stores the status beside the HTML
      // and serves it on every hit, so a 404 under `isr` is a 404 for its whole TTL.
      const served = await isr.serve(isrKey(url, ctx.locale), async () => ({
        html: await documentFrom(entry, request, data, options),
        status,
      }));
      return served.result;
    }
    case 'stream': {
      // The shell IS the component: nothing can yet mark a subtree as a hole. Solid's `Suspense`
      // is not the missing piece and never will be here — it calls `getContextId()`, which throws
      // outside a Solid renderer, and this package's JSX factory is inert by design. A hole marker
      // has to be the framework's own. Until it exists the first flush carries the whole body —
      // correct output, no streaming benefit.
      const islands = collectorFor(entry, options);
      const [head, shell] = await Promise.all([
        headFor(entry, request, data, options),
        routeBody(entry, request, data, islands),
      ]);
      return streamResult(
        {
          head: `<!doctype html><html lang="${lang()}"><head>${head}${styleTag(entry)}</head><body>`,
          // The runtime rides the first flush, with the shell it boots. A later chunk would leave
          // the window between flush one and the close with inert islands and no listeners on
          // them — which is exactly the first-click-lost failure `interaction` replay exists for.
          shell: `${shell}${hydrateRuntime(islands.directives)}`,
          holes: [],
        },
        { buildId: options.buildId },
        status,
      );
    }
    default:
      return renderSsr(
        { entry, params: request.params, url, ctx },
        () => documentFrom(entry, request, data, options),
        { buildId: options.buildId, status },
      );
  }
}

const responseOf = (result: RenderResult): Response =>
  typeof result.body === 'string'
    ? html(result.body, { status: result.status, headers: result.headers })
    : stream(result.body, { status: result.status, headers: result.headers });

/**
 * `auth` follows the route's own guard, so a gated page is gated in dev by the same pipeline
 * stage that gates it in production. A route that declares no policy is public by declaration.
 */
const metaOf = (entry: RouteEntry): HttpRouteMeta => ({
  name: entry.file,
  auth: entry.config.policy === undefined ? 'public' : 'required',
  render: entry.config.render,
  tags: [entry.surface],
  ...(entry.config.policy === undefined ? {} : { policy: entry.config.policy.permission }),
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
  const isr = options.isr ?? createIsrController({ buildId: options.buildId });
  return routeEntries().map((registered) => ({
    method: 'GET' as const,
    path: registered.path,
    get meta(): HttpRouteMeta {
      return metaOf(routeFor(registered.path) ?? registered);
    },
    // `ctx.params` is the router's own match — the CLI never re-parses a path it did not match.
    handler: async (request, ctx): Promise<Response> => {
      const entry = routeFor(registered.path) ?? registered;
      const data: DevRouteData = { url: request.url.href, params: ctx.params };
      return responseOf(await resultFor(entry, data, options, isr, asCtx(ctx)));
    },
  }));
}
