// Projecting the route table onto HTTP routes both boots serve. Every mode goes through
// `@ultimat3/render`'s own function for that mode — the CLI picks the mode and supplies the
// document (head + the route's component, the surface's CSS LINKED, `style-bundle.ts`), it never
// decides what a mode means or what headers it earns.

import { clientScopeOf } from '@ultimat3/auth';
import type { Actor, Ctx } from '@ultimat3/core';
import { CLIENT_SCOPE_HEADER, singleFlight } from '@ultimat3/core';
import type {
  RouteMeta as HttpRouteMeta,
  RedirectIntent,
  RequestContext,
  Route,
  UltimateRequest,
} from '@ultimat3/http';
import {
  asCtx,
  NO_STORE,
  redirect,
  stream,
  takeRedirect,
  withAnonymousRequest,
} from '@ultimat3/http';
import type { RenderResult, RouteData, RouteEntry } from '@ultimat3/render';
import {
  documentCarriesScope,
  routeDataFor,
  routeEntries,
  routeFor,
  routeStatusOf,
} from '@ultimat3/render';
import type { IsrController } from '@ultimat3/render/server';
import {
  contentHash,
  holeSink,
  renderSsr,
  ssrHeaders,
  staticHeaders,
  streamResult,
} from '@ultimat3/render/server';
import {
  type NavigationDocumentHead,
  navigationMetaOf,
  principalRelocation,
} from './page-navigation';
import { bootScript, collectorFor, streamScripts } from './route-islands';
import { linkHeader, preloadUrls } from './route-islands-preload';
import { addressedUrl } from './runtime-address';
import { attachedIsr } from './runtime-isr';
import { isrOutcome } from './runtime-isr-outcome';
import type { DevRouteData, RenderOptions } from './runtime-render-document';
import {
  documentFrom,
  headFor,
  lang,
  renderedDocument,
  routeBody,
  stylesFor,
  stylesheetOf,
} from './runtime-render-document';
import type { StaticResult } from './static-document';
import { createStaticMemo, staticMemoKey, staticResponse } from './static-document';
import { enterHole } from './stream-hole-scope';

export type { DocumentOptions, IslandResolver } from './document-options';

export interface DevRenderOptions extends RenderOptions {
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
/**
 * Head + body for one route render — the document `x dev` serves, which the build's prerenderer
 * must emit too.
 */
export async function routeDocument(
  entry: RouteEntry,
  ctx: DevRouteData,
  options: RenderOptions = {},
): Promise<string> {
  return documentFrom(entry, ctx, await routeDataFor(entry.config, ctx), options);
}

/**
 * The document a request by `actor` is SERVED: `routeDocument` plus the scope the response would
 * carry, which is what earns the page boot. The build weighs an app/ page through this — a budget
 * is a promise about what that page's browser downloads (#505).
 */
export async function servedDocument(
  entry: RouteEntry,
  ctx: DevRouteData,
  actor: Actor,
  options: RenderOptions & { readonly buildId: string },
): Promise<string> {
  const data = await routeDataFor(entry.config, ctx);
  return documentFrom(entry, ctx, data, options, documentScope(entry, options.buildId, actor));
}

/**
 * Whether, and as whom, a mode's response is scoped — ONE decision for the request path and for
 * `servedDocument`. A stream is always `private, no-store`; an ssr page carries the scope when the
 * headers `renderSsr` sends are private; a static or isr document is shareable.
 */
function documentScope(entry: RouteEntry, buildId: string, actor: Actor): string | undefined {
  switch (entry.config.render) {
    case 'static':
    case 'isr':
      return undefined;
    case 'stream':
      return clientScopeOf(actor);
    default:
      return documentCarriesScope(ssrHeaders(entry, { buildId }))
        ? clientScopeOf(actor)
        : undefined;
  }
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
      const { html: body, link } = await renderedDocument(entry, request, data, options);
      return withLink(
        { status, headers: staticHeaders(contentHash(body), options.buildId), body },
        link,
      );
    }
    case 'stream': {
      // Everything outside a `<Hole>` is the first flush; every hole fills after it, in the
      // request's context, in completion order. `status` and any redirect were decided by `load`
      // above: a hole starts after the headers left, so its failure is its own error markup.
      // A stream is always `private, no-store` (`streamResult`), so it always carries the scope.
      const scope = documentScope(entry, options.buildId, ctx.actor);
      const islands = collectorFor(entry, options, scope);
      const sink = holeSink({ enter: enterHole });
      const [head, shell] = await Promise.all([
        headFor(entry, request, data, options, scope),
        routeBody(entry, request, data, islands, sink),
      ]);
      const scripts = streamScripts(entry, islands, options, scope, sink.holes.length > 0);
      // The first flush's tags, recomputed from the same recorded islands: the headers leave first.
      const booted = bootScript(entry, islands, options, scope) !== '';
      const link = linkHeader(stylesheetOf(entry), preloadUrls(entry, islands, options, booted));
      return withScope(
        withLink(
          streamResult(
            {
              head: `<!doctype html><html lang="${lang()}"><head>${head}${stylesFor(entry)}</head><body>`,
              // The runtime rides the first flush, with the shell it boots. A later chunk would leave
              // the window between flush one and the close with inert islands and no listeners on
              // them — the first-click-lost failure `interaction` replay exists for.
              shell: `${shell}${scripts.first}`,
              holes: sink.holes.map((hole) => ({ ...hole, after: scripts.after })),
            },
            { buildId: options.buildId },
            status,
          ),
          link,
        ),
        scope,
      );
    }
    default: {
      // Asked of the headers `renderSsr` is about to send: a gated page is private and carries the
      // scope; an ungated one is `public, s-maxage` and a CDN may hand it to anyone, so it carries
      // none — absent, which core reads as "not rendered for anyone", never as anonymous.
      const scope = documentScope(entry, options.buildId, ctx.actor);
      let link: string | undefined;
      const result = await renderSsr(
        { entry, params: request.params, url, ctx },
        async () => {
          const rendered = await renderedDocument(entry, request, data, options, scope);
          link = rendered.link;
          return rendered.html;
        },
        { buildId: options.buildId, status },
      );
      return withScope(withLink(result, link), scope);
    }
  }
}

/** The document's early fetches as a `Link` header (`route-islands-preload.ts`), when it has any. */
const withLink = (result: RenderResult, link: string | undefined): RenderResult =>
  link === undefined ? result : { ...result, headers: { ...result.headers, link } };

/**
 * A private document's scope, as a RESPONSE header too: the service worker partitions its offline
 * pages by principal and never parses HTML, so the meta alone cannot reach it.
 */
const withScope = (result: RenderResult, scope: string | undefined): RenderResult =>
  scope === undefined
    ? result
    : { ...result, headers: { ...result.headers, [CLIENT_SCOPE_HEADER]: scope } };

/**
 * A loader's redirect. No declared `cache` means `private, no-store`: the loader decided it for
 * THIS request, and the mode's default would offer that decision to a CDN, which would then answer
 * every later request without running the loader.
 */
function loadRedirect(entry: RouteEntry, to: RedirectIntent): Response {
  const response = redirect(to.location, to.status);
  if (entry.config.cache === undefined) response.headers.set('cache-control', 'private, no-store');
  return response;
}
/**
 * A buffered document answers through `staticResponse`, so a 200 carrying a validator (`ssr`'s
 * cacheable pages, `isr`'s) is a 304 to a request that names it, as a `static` page always was.
 */
const responseOf = (request: UltimateRequest, result: RenderResult): Response =>
  typeof result.body === 'string'
    ? staticResponse(request, { ...result, body: result.body })
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
  // stage applies it to a response that wrote none — a loader's redirect.
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
 * save. `meta` was the same defect one stage earlier, and this getter is what makes that read the
 * table's: the pipeline's `auth` and `authz` stages read `route.meta` per request. The path cannot
 * move under a reload, so the captured entry is only the fallback for a cleared table.
 */
export function appRoutes(options: DevRenderOptions): readonly Route[] {
  const isr = options.isr ?? attachedIsr({ buildId: options.buildId }).isr;
  const memo = createStaticMemo();
  // A cold static key is ONE render however many requests arrive during it: the memo alone was
  // check-then-act, so a burst at boot ran `load` and the render once per request.
  const firstRender = singleFlight();
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
          ? staticMemoKey(entry, addressedUrl(request.url, ctx), asCtx(ctx).locale, options.origin)
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
        ? rendered.respond(request)
        : staticResponse(request, rendered.document);
    },
  }));
}

/** A static document a joined request can share, or how to answer when there is none. */
interface Rendered {
  readonly document?: StaticResult;
  readonly respond: (request: UltimateRequest) => Response;
}

async function renderEntry(
  entry: RouteEntry,
  request: UltimateRequest,
  ctx: RequestContext,
  options: DevRenderOptions,
  isr: IsrController,
): Promise<Rendered> {
  // A `static` document is one file in the export, so it is rendered AT its one address here too.
  const at = entry.config.render === 'static' ? addressedUrl(request.url, ctx) : request.url;
  const data: DevRouteData = { url: at.href, params: ctx.params };
  if (entry.config.render === 'isr') return renderIsr(entry, data, ctx, options, isr);
  // A `static` document is kept and answered to every later visitor, so it is rendered as nobody,
  // `load` and document both: the memo and a CDN would otherwise hold this visitor's answer.
  if (entry.config.render === 'static') {
    return withAnonymousRequest(ctx, at, (scope) => loadAndRender(entry, data, scope, options));
  }
  return loadAndRender(entry, data, ctx, options);
}

/** Every mode but `isr`, whose `load` is inside its producer (`runtime-isr-outcome.ts`). */
async function loadAndRender(
  entry: RouteEntry,
  data: DevRouteData,
  ctx: RequestContext,
  options: DevRenderOptions,
): Promise<Rendered> {
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
    return { respond: (request) => responseOf(request, result) };
  }
  const document: StaticResult = { ...result, body: result.body };
  return { document, respond: (request) => responseOf(request, document) };
}

/** `isr`'s outcome (`runtime-isr-outcome.ts`) as this file's answer: a page, or the redirect. */
async function renderIsr(
  entry: RouteEntry,
  data: DevRouteData,
  ctx: RequestContext,
  options: DevRenderOptions,
  isr: IsrController,
): Promise<Rendered> {
  const document = (loaded: RouteData, at: DevRouteData): Promise<string> =>
    documentFrom(entry, at, loaded, options);
  const outcome = await isrOutcome({
    entry,
    data,
    ctx,
    isr,
    document,
    origin: options.origin,
  });
  if (outcome.kind === 'redirect') return { respond: () => loadRedirect(entry, outcome.to) };
  return { respond: (request) => responseOf(request, outcome.result) };
}
