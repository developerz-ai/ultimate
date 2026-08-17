// Projecting the route table onto HTTP routes `x dev` can serve. Every mode goes through
// `@ultimat3/render`'s own function for that mode — the CLI picks the mode and supplies the
// document, it never decides what a mode means or what headers it earns.
//
// The document is head + the route's own component, rendered by `@ultimat3/render`'s server JSX
// writer, with the surface's compiled CSS inlined. Inlined rather than linked because a `site/`
// page is a 0kb-JS artifact a CDN serves as one file: a stylesheet link would add a round trip to
// the render path the mode exists to make cheap, and a static export would need a second file.

import type { Ctx } from '@ultimat3/core';
import type { RouteMeta as HttpRouteMeta, Route, RouteParams } from '@ultimat3/http';
import { asCtx, html, stream } from '@ultimat3/http';
import { currentLocale } from '@ultimat3/i18n';
import type {
  IslandCollector,
  IsrController,
  RenderResult,
  RouteData,
  RouteEntry,
} from '@ultimat3/render';
import {
  contentHash,
  createIslandCollector,
  createIsrController,
  headFromMeta,
  hydrateRuntime,
  metaContextFor,
  renderComponent,
  renderHead,
  renderSpa,
  renderSsr,
  routeDataFor,
  routeEntries,
  SPA_ROOT_ID,
  seoRenderers,
  staticHeaders,
  streamResult,
  stylesFor,
} from '@ultimat3/render';

/**
 * Specifier → built chunk URL, bound to the route file the specifier is written relative to.
 * Supplied by whoever built the islands (`x dev`, the container, the static build); absent means
 * no island was built, and a page that renders one then fails by name rather than emitting a
 * `data-x-entry` nothing can import.
 */
export type IslandResolver = (routeFile: string) => (src: string) => string;

export interface DocumentOptions {
  readonly resolveIsland?: IslandResolver;
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

const headFor = async (entry: RouteEntry, ctx: DevRouteData, data: RouteData): Promise<string> =>
  renderHead(
    headFromMeta(
      await entry.config.meta(metaContextFor(ctx, data)),
      seoRenderers({ path: new URL(ctx.url).pathname }),
    ),
  );

/** `<style>` for the surface's own stylesheets, or nothing at all when the surface imports none. */
const styleTag = (entry: RouteEntry): string => {
  const css = stylesFor(entry.surface);
  return css.length === 0 ? '' : `<style>${css}</style>`;
};

/**
 * The route's rendered body, inside the hydration root. A module that exports no component (an
 * `api/` route, or a `spa` whose data is all client-side) renders an empty root, which is the
 * shell those modes are defined to serve — not a fallback for a component that failed.
 */
export async function routeBody(
  entry: RouteEntry,
  ctx: DevRouteData,
  data: RouteData,
  islands: IslandCollector,
): Promise<string> {
  if (entry.component === undefined) return `<div id="${SPA_ROOT_ID}"></div>`;
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
  return `<div id="${SPA_ROOT_ID}">${html}</div>`;
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
    headFor(entry, ctx, data),
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
  switch (entry.config.render) {
    case 'static': {
      // Not `renderStatic`: that enumerates every prerendered path for the build. A request
      // names exactly one, and it earns the same content-hashed headers.
      const body = await documentFrom(entry, request, data, options);
      return { status: 200, headers: staticHeaders(contentHash(body), options.buildId), body };
    }
    case 'isr': {
      const served = await isr.serve(url.pathname, () =>
        documentFrom(entry, request, data, options),
      );
      return served.result;
    }
    case 'spa':
      // The shell renders no body by definition, but it still carries the surface's CSS: the
      // client paints into `#x-root` and a flash of unstyled shell is the mode's own regression.
      return renderSpa({
        entry,
        buildId: options.buildId,
        head: (await headFor(entry, request, data)) + styleTag(entry),
        chunks: [],
        lang: lang(),
      });
    case 'stream': {
      // The shell IS the component: nothing can yet mark a subtree as a hole. Solid's `Suspense`
      // is not the missing piece and never will be here — it calls `getContextId()`, which throws
      // outside a Solid renderer, and this package's JSX factory is inert by design. A hole marker
      // has to be the framework's own. Until it exists the first flush carries the whole body —
      // correct output, no streaming benefit.
      const islands = collectorFor(entry, options);
      const [head, shell] = await Promise.all([
        headFor(entry, request, data),
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
      );
    }
    default:
      return renderSsr(
        { entry, params: request.params, url, ctx },
        () => documentFrom(entry, request, data, options),
        { buildId: options.buildId },
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

/** One HTTP route per registered `route` primitive, in the table's own order. */
export function appRoutes(options: DevRenderOptions): readonly Route[] {
  const isr = options.isr ?? createIsrController({ buildId: options.buildId });
  return routeEntries().map((entry) => ({
    method: 'GET' as const,
    path: entry.path,
    meta: metaOf(entry),
    // `ctx.params` is the router's own match — the CLI never re-parses a path it did not match.
    handler: async (request, ctx): Promise<Response> => {
      const data: DevRouteData = { url: request.url.href, params: ctx.params };
      return responseOf(await resultFor(entry, data, options, isr, asCtx(ctx)));
    },
  }));
}
