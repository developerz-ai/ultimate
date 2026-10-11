// What one `isr` request is answered with: a page from the store, or the redirect ITS OWN `load`
// decided. A returned discriminated outcome, never a throw: the controller's regeneration treats
// anything thrown as a failure and logs it, and a redirect is an ordinary answer, not a failure.

import { logger } from '@ultimat3/core';
import type { RedirectIntent, RequestContext, RouteParams } from '@ultimat3/http';
import { asCtx, takeRedirect } from '@ultimat3/http';
import type { RenderResult, RouteData, RouteEntry } from '@ultimat3/render';
import { routeDataFor, routeNoStoreOf, routeStatusOf } from '@ultimat3/render';
import type { IsrController, IsrEntry } from '@ultimat3/render/server';
import { isrKey, isrRequestUrl, undeclaredQuery } from '@ultimat3/render/server';

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
  /**
   * The route's whole document for what `load` returned (`runtime-render.ts`'s `documentFrom`),
   * rendered AT the data this file hands it — the narrowed URL, never the request's own.
   */
  readonly document: (loaded: RouteData, at: IsrData) => Promise<string>;
}

/** Route files already told, once, about a request whose query they never declared. */
const toldUndeclared = new Set<string>();

/** Names are the visitor's: a few, cut short, is all a log line needs to name the edit. */
const NAMED_PARAMS = 5;
const NAMED_PARAM_CHARS = 40;

/**
 * The request narrowed to what the route declared it varies on (`revalidate.query`). ONE narrowing
 * feeds the store key, `load`, `meta` and the page, so a parameter outside the key cannot reach
 * the document stored under it.
 *
 * A route that declared NOTHING still keys on the whole query, and is told so once, the first time
 * a visitor uses that: every distinct query string is then a render and a stored page of its own.
 */
function keyedData(entry: RouteEntry, data: IsrData): IsrData {
  const url = new URL(data.url);
  const declared = entry.config.revalidate?.query ?? null;
  if (declared === null && !toldUndeclared.has(entry.file)) {
    const minted = undeclaredQuery(url, declared);
    if (minted.length > 0) {
      toldUndeclared.add(entry.file);
      logger.warn('isr.query.undeclared', {
        route: entry.file,
        params: minted.slice(0, NAMED_PARAMS).map((name) => name.slice(0, NAMED_PARAM_CHARS)),
        cause:
          'the route declares no revalidate.query, so every distinct query string is rendered and stored as its own page',
        fix: `revalidate: { query: [] }   // in ${entry.file}; or query: ['<name>'] for each parameter the page varies on`,
      });
    }
  }
  return { ...data, url: isrRequestUrl(url, declared).href };
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
 * the request's own (its `load` may have read a cookie), so a request that joined a run whose load
 * redirected decides for itself, exactly as the static single-flight in `appRoutes` does.
 */
export async function isrOutcome(arrived: IsrRequest): Promise<IsrOutcome> {
  const request: IsrRequest = { ...arrived, data: keyedData(arrived.entry, arrived.data) };
  const { entry, data, ctx, isr } = request;
  // `isrKey(url, locale)`, never `url.pathname`: the DECLARED query is part of what was rendered —
  // `meta` reads `data.url` — so two URLs differing in it are two documents (#171). The locale is
  // `ctx.locale`, the one the `locale` stage negotiated for THIS request.
  const key = isrKey(new URL(data.url), asCtx(ctx).locale);
  let decided: RedirectIntent | undefined;
  // `{ html, status }`, never the bare string: the entry stores the status beside the HTML and
  // serves it on every hit, so a 404 under `isr` is a 404 for its whole TTL.
  const served = await isr.serve(key, async () => {
    const loaded = await routeDataFor(entry.config, data);
    const to = takeRedirect(ctx);
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
  });
  if (decided !== undefined) return { kind: 'redirect', to: decided };
  if (!isRedirectMarker(served.entry)) return { kind: 'page', result: served.result };
  return ownOutcome(request);
}

/**
 * A joiner whose leader's load redirected: its own `load`, answered for this request alone. A page
 * here is NOT stored — the store was just told the key has none — so it is `private, no-store`;
 * the next request to miss stores one.
 */
async function ownOutcome(request: IsrRequest): Promise<IsrOutcome> {
  const loaded = await routeDataFor(request.entry.config, request.data);
  const to = takeRedirect(request.ctx);
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
}
