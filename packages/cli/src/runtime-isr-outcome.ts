// What one `isr` request is answered with: a page from the store, or the redirect ITS OWN `load`
// decided. A returned discriminated outcome, never a throw: the controller's regeneration treats
// anything thrown as a failure and logs it, and a redirect is an ordinary answer, not a failure.

import { logger } from '@ultimat3/core';
import type { RedirectIntent, RequestContext, RouteParams } from '@ultimat3/http';
import { asCtx, requestAddress, takeRedirect, withAnonymousRequest } from '@ultimat3/http';
import type { RenderResult, RouteData, RouteEntry } from '@ultimat3/render';
import { describePages, routeDataFor, routeNoStoreOf, routeStatusOf } from '@ultimat3/render';
import type { IsrController, IsrEntry } from '@ultimat3/render/server';
import { isrKey, isrRequestUrl, isrRouteFor } from '@ultimat3/render/server';

export type IsrOutcome =
  | { readonly kind: 'page'; readonly result: RenderResult }
  | { readonly kind: 'redirect'; readonly to: RedirectIntent };

/** What `load` and `meta` are given; `url` is a string because that is what `ld.*` embeds. */
type IsrData = { readonly url: string; readonly params: RouteParams } & Record<string, unknown>;

export interface IsrRequest {
  readonly entry: RouteEntry;
  /** The request as it arrived. `load`, `meta` and the page get `keyedData`'s narrowing of it. */
  readonly data: IsrData;
  readonly ctx: RequestContext;
  readonly isr: IsrController;
  /** The app's declared public origin (`publicOrigin()`), or nothing: then the request's is keyed. */
  readonly origin: string | undefined;
  /**
   * The route's whole document for what `load` returned (`runtime-render-document.ts`'s `documentFrom`),
   * rendered AT the data this file hands it — the narrowed URL, never the request's own.
   */
  readonly document: (loaded: RouteData, at: IsrData) => Promise<string>;
}

/**
 * The request narrowed to what the route declared it varies on (`revalidate.query`), AT the one
 * spelling of its address (`pathname`). ONE narrowing feeds the store key, `load`, `meta` and the
 * page, so neither a parameter outside the key nor the way a visitor happened to spell the path
 * (`/blog//a/`, `/blog/%61`) can reach the document stored under it.
 *
 * The origin is the same narrowing: a declared one replaces the request's before the key, so `load`
 * and the page are handed the address the document's own canonical names, whatever `Host` arrived.
 */
function keyedData(
  entry: RouteEntry,
  data: IsrData,
  pathname: string | undefined,
  origin: URL | undefined,
): IsrData {
  const url = new URL(data.url);
  if (pathname !== undefined) url.pathname = pathname;
  if (origin !== undefined) {
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    // `port` and not `host`: a `host` with no port leaves the request's, so `evil.test:8443` named
    // itself in the document after all.
    url.port = origin.port;
  }
  return { ...data, url: isrRequestUrl(url, entry.config.revalidate?.query ?? null).href };
}

/**
 * The declared origin, when it is one: http or https. `APP_URL` is an operator's string and nothing
 * has read it as a URL by here. One that does not parse would be a 500 on every `isr` page, and
 * `localhost:3000` parses with `localhost:` as its scheme, where URL setters do nothing and every
 * host would share one key. Both are keyed as undeclared: against the request, as the head falls back.
 */
function declaredOrigin(origin: string | undefined): URL | undefined {
  if (origin === undefined || !URL.canParse(origin)) return undefined;
  const parsed = new URL(origin);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
}

/**
 * How many request origins one controller stores pages for when the app declares none. A `Host` is
 * the visitor's to choose, so each new one would be a render and an entry pushing a real page out
 * of the bounded store. Past the cap a NEW origin is refused rather than anything evicted, as
 * `static-document.ts`'s memo does: answered, its own canonical, never stored.
 */
export const ISR_MAX_REQUEST_ORIGINS = 16;

/** Per controller, so a `stop` that drops the store drops what it had admitted. */
const admittedOrigins = new WeakMap<IsrController, Set<string>>();

function admitsOrigin(isr: IsrController, origin: string, route: string): boolean {
  const admitted = admittedOrigins.get(isr) ?? new Set<string>();
  admittedOrigins.set(isr, admitted);
  if (admitted.has(origin)) return true;
  if (admitted.size < ISR_MAX_REQUEST_ORIGINS) {
    admitted.add(origin);
    return true;
  }
  if (admitted.size === ISR_MAX_REQUEST_ORIGINS) {
    // Told once: a sentinel past the cap, which nothing else ever reads as an origin.
    admitted.add('');
    logger.warn('isr.origin.over_cap', {
      route,
      cause: `this process has stored pages for ${ISR_MAX_REQUEST_ORIGINS} request origins and the app declares none, so a page for any other Host is answered uncached`,
      fix: 'APP_URL=https://your.domain   # or site: { origin } in app.config.ts',
    });
  }
  return false;
}

/**
 * The producer's answer when `load` redirected. A 3xx status is never a page — `withStatus` refuses
 * one by name, because a document has no `Location` — so a 3xx entry can only be this marker, and a
 * request that JOINED the flight reads it as "the leader's load redirected for the leader".
 */
const isRedirectMarker = (entry: IsrEntry): boolean => {
  // An entry stored before statuses were (`status` absent) is a 200, and never this marker.
  const { status } = entry;
  return status !== undefined && status >= 300 && status < 400;
};

/**
 * A redirect means the key holds no page. Deleting drops the stale copy, so the next request is a
 * miss and decides again. `markStale` records an invalidation of the key AFTER the regeneration's
 * fence was sampled, and the controller refuses to store a render its fence no longer covers — so
 * the marker this producer returns is never published, and never served from the store.
 */
function dropPage(isr: IsrController, key: string): void {
  isr.store().delete(key);
  isr.markStale(key);
}

/**
 * `isr`: a store hit is answered WITHOUT `load` — resolving it before the mode choice, as every
 * other mode does, made each hit cost a full SSR's database work. So `load` and its redirect live
 * inside the producer, which runs on a miss and on a stale page's regeneration.
 *
 * Concurrent misses on one key share ONE producer run, and only a PAGE may be shared. A redirect is
 * never stored, so it stays the decision of the render that made it: a request that joined a run whose load
 * redirected decides for itself, exactly as the static single-flight in `appRoutes` does.
 *
 * `load` and the document run as nobody, on every path (`withAnonymousRequest`): what is stored is
 * answered to every later visitor, so it may not hold what this one's identity could read.
 */
export async function isrOutcome(arrived: IsrRequest): Promise<IsrOutcome> {
  // Where the router MATCHED this request, never where the visitor wrote it: the router answers
  // many spellings with one page, and a key built from the raw pathname stored each of them.
  const address = requestAddress(arrived.ctx);
  const origin = declaredOrigin(arrived.origin);
  const request: IsrRequest = {
    ...arrived,
    data: keyedData(arrived.entry, arrived.data, address?.pathname, origin),
  };
  const { entry, data, ctx, isr } = request;
  // `isrKey(url, locale, origin)`, never `url.pathname`: the DECLARED query is part of what was rendered —
  // `meta` reads `data.url` — so two URLs differing in it are two documents (#171). The locale is
  // `ctx.locale`, the one the `locale` stage negotiated for THIS request. The key's path carries
  // NO base path: the route table has never heard of the mount, so a key that kept it matched no
  // route — and every `isr` page of an app under a `basePath` was stored with no ttl and no tags.
  const keyed = new URL(data.url);
  if (address !== undefined) keyed.pathname = address.path;
  // No origin declared: the document's canonical is absolute against the request's, so a foreign
  // `Host` is its own entry and never names itself in the page the next visitor gets.
  const key = isrKey(keyed, asCtx(ctx).locale, origin === undefined ? keyed.origin : undefined);
  // The key has to read back as THIS route, or its ttl, its tags and what a bust does to it are
  // another route's or nobody's. It always does for an address the framework's URL scheme can
  // spell; what is left is a path the router matched that another reading claims (`//en/x` is the
  // `/:lang/x` route with no locale, and `/en/x` is the `/x` route in English). Answered, uncached.
  if (isrRouteFor(describePages(), key)?.file !== entry.file) return ownOutcome(request);
  if (origin === undefined && !admitsOrigin(isr, keyed.origin, entry.file)) {
    return ownOutcome(request);
  }
  let decided: RedirectIntent | undefined;
  // `{ html, status }`, never the bare string: the entry stores the status beside the HTML and
  // serves it on every hit, so a 404 under `isr` is a 404 for its whole TTL.
  const served = await isr.serve(key, () =>
    withAnonymousRequest(ctx, new URL(data.url), async (scope) => {
      const loaded = await routeDataFor(entry.config, data);
      const to = takeRedirect(scope);
      if (to === undefined) {
        return {
          html: await request.document(loaded, data),
          status: routeStatusOf(loaded),
          noStore: routeNoStoreOf(loaded),
        };
      }
      // Set by THIS request's producer only. On a stale page it runs behind the answer, and when it
      // has already decided by the time `serve` returns, the redirect is still this request's own.
      decided = to;
      dropPage(isr, key);
      return { html: '', status: to.status };
    }),
  );
  if (decided !== undefined) return { kind: 'redirect', to: decided };
  if (!isRedirectMarker(served.entry)) return { kind: 'page', result: served.result };
  return ownOutcome(request);
}

/**
 * A request answered for itself alone: a joiner whose leader's load redirected, or one whose key
 * is not its own route's. Its own `load`; a page here is NOT stored — the store was just told the
 * key has none, or the key is another page's — so it is `private, no-store`. Still as nobody: not
 * to protect the store, but because one route renders one way, whichever path a request took.
 */
function ownOutcome(request: IsrRequest): Promise<IsrOutcome> {
  return withAnonymousRequest(
    request.ctx,
    new URL(request.data.url),
    async (scope): Promise<IsrOutcome> => {
      const loaded = await routeDataFor(request.entry.config, request.data);
      const to = takeRedirect(scope);
      if (to !== undefined) return { kind: 'redirect', to };
      const body = await request.document(loaded, request.data);
      return {
        kind: 'page',
        result: {
          status: routeStatusOf(loaded),
          headers: { 'cache-control': 'private, no-store' },
          body,
        },
      };
    },
  );
}
