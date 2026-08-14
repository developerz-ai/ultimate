/**
 * Resolving a route's data, once per render. Every consumer that renders a document — `x dev`, the
 * build's prerenderer, every render mode — MUST come through here, because `meta` and the page
 * component have to be given the SAME object. Two resolutions is a `<title>` describing content
 * the body does not contain.
 */

import { isUltimateError } from '@ultimat3/core';
import { useI18n } from '@ultimat3/i18n';
import { RouteLoadFailedError } from './errors';
import type { RouteConfig, RouteContext, RouteData, RouteMetaContext } from './route';

/**
 * The route's data for one render.
 *
 * With no `load` the context itself is the data, which is exactly what `meta` received before
 * `load` existed — so an untouched route keeps reading `data.url` and `data.params` and nothing
 * that shipped has to change. Callers therefore never branch on whether a route declared one.
 */
export async function routeDataFor<TData = RouteData>(
  config: RouteConfig<TData>,
  ctx: RouteContext,
): Promise<TData> {
  // The context IS the data, and `defineRoute`'s `LoadRequirement` is what makes that true: a
  // route whose `meta` reads more than `{ params, url }` cannot compile without a `load`, so
  // `RouteContext` satisfies `TData` on this line. One narrowing assertion backed by a build
  // error, in place of the `as unknown as` that used to hand back any shape a caller named.
  if (config.load === undefined) return ctx as RouteContext & TData;
  try {
    return await config.load(ctx);
  } catch (cause) {
    // Rethrown as-is when it is already one of ours: a loader that failed its OWN way — a policy
    // denial, a missing row — has a better code and a better fix than anything this frame knows,
    // and wrapping it would bury both behind a generic one. Read through core's brand, never a
    // `code` property: an ENOENT off `Bun.file` carries `code: 'ENOENT'`, and the duck-type let
    // every one of them out of here unwrapped — no fix line, and no mention of the route to fix.
    if (isUltimateError(cause)) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RouteLoadFailedError(
      `load() threw while rendering ${new URL(ctx.url).pathname}: ${detail}`,
      `fix the load function for ${new URL(ctx.url).pathname}, or return a fallback so the page can render`,
    );
  }
}

/**
 * The argument `meta` is called with. Built here rather than at each call site so `x dev` and the
 * build's prerenderer cannot disagree about what `meta` receives — two builders is a `<title>`
 * that differs between the page a developer sees and the one a crawler gets.
 *
 * `t` is resolved per call from the ambient locale, never captured: a translator held across
 * requests would render every visitor the first one's language.
 */
export function metaContextFor<TData = RouteData>(
  ctx: RouteContext,
  data: TData,
): RouteMetaContext<TData> {
  return { data, params: ctx.params, url: ctx.url, t: useI18n() };
}
