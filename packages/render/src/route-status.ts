// The one way a loader answers a response STATUS while still rendering the route's own page.
//
// Measured in ai-maxxing, 2026-09-07: `/fleet/nope` — a host id the fleet does not have — rendered
// the app's own "Not found" page inside its shell, the right page, and answered **200**. The only
// route to a 404 was throwing, and a throw renders the framework's error page OUTSIDE the shell.
// So an app that did the right thing for its visitor could not do the right thing for a crawler,
// a CDN or a monitor, and one that did the right thing for those lost its shell.
//
// The status rides ON the data, by identity: `withStatus(404, data)` hands the same object back,
// so `load`'s return type is untouched, `routeDataFor` still hands ONE object to `meta` and the
// page, and every consumer that never asks reads 200. A `WeakMap` and not a symbol property — the
// data may be frozen, may be a class instance, and is the author's; nothing here writes into it.
// A `RouteContext` method (`ctx.notFound()`) was the alternative and was refused: every builder of
// a context — `x dev`, the prerenderer, the SEO scan, both scaffold templates — would have had to
// learn to supply it, and an optional method is a second way.

import { RouteStatusInvalidError } from './errors';
import { finiteStatus } from './finite-status';

/** What every render answers when the loader said nothing, and what a no-`load` route answers. */
export const DEFAULT_ROUTE_STATUS = 200;

const STATUSES = new WeakMap<object, number>();

/**
 * What `withStatus` can mark, read back off `unknown`: exactly TypeScript's `object` — a non-null
 * object OR a function. Both are `WeakMap` keys and both satisfy `withStatus`'s constraint, so a
 * loader answering `withStatus(404, () => …)` — data that is a function, which `load`'s type
 * allows — must read back as 404 and not as the default. The two sides of the seam share this
 * one predicate so they cannot disagree about what carries a status.
 */
const canCarryStatus = (data: unknown): data is object =>
  (typeof data === 'object' && data !== null) || typeof data === 'function';

const isRedirect = (status: number): boolean => status >= 300 && status < 400;

/**
 * Answer `status` for this render, and render the page with `data` all the same.
 *
 * Any 2xx, 4xx or 5xx. A 3xx is refused by name: a redirect is a `Location` and no body, which is
 * `@ultimat3/http`'s `redirect()` and never a page. Out of range is `finiteStatus`'s refusal, the
 * same screen `renderSsr` and `streamResult` apply — `NaN` reaching `new Response` is a bare
 * `RangeError` two frames above the loader that set it.
 *
 * A 4xx or 5xx is `robots: noindex` BY CONSTRUCTION — `defineRoute`'s `meta` wrapper applies it —
 * so a page that does not exist is never indexed however its `meta` was written.
 */
export function withStatus<TData extends object>(status: number, data: TData): TData {
  const screened = finiteStatus('withStatus', status);
  if (isRedirect(screened)) {
    throw new RouteStatusInvalidError(
      `withStatus(${String(screened)}, …) asks a page to be a redirect, and a rendered document has no Location to send`,
      "answer 2xx, 4xx or 5xx from load; a redirect is `redirect(location)` from '@ultimat3/http', thrown or returned by the handler",
    );
  }
  STATUSES.set(data, screened);
  return data;
}

/**
 * The status a render of `data` answers: what `withStatus` recorded, else 200. TOTAL, and asked
 * of `unknown` on purpose — the callers are the render modes, and the data is whatever the app's
 * loader returned, an object or not.
 */
export function routeStatusOf(data: unknown): number {
  if (!canCarryStatus(data)) return DEFAULT_ROUTE_STATUS;
  const status = STATUSES.get(data);
  return status === undefined ? DEFAULT_ROUTE_STATUS : status;
}

/** A 4xx or 5xx: a document a crawler must forget, whatever its `meta` said. */
export const isErrorStatus = (status: number): boolean => status >= 400;
