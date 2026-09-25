// The locale a URL names. A leading `/<locale>/` segment is split off BEFORE the route table is
// matched — so `/en/precios` is the `/precios` route in English and `/fr/x` is still a 404 — and
// it is authoritative over query, cookie, user and header. Which locales route, and how a path is
// spelled in one, are `@ultimat3/i18n`'s; this file only applies them to a request.

import { type LocaleSources, localeConfig, resolveLocale, splitLocalePrefix } from '@ultimat3/i18n';
import type { RequestContext } from './context';

/** Methods whose redirect may change nothing but the URL. Anything else is a 308, never a 301. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * The pathname the router should match, or the redirect that answers the request instead.
 *
 * A prefix naming the DEFAULT locale is a duplicate URL (`/es-co/precios` is `/precios`), so it is
 * answered with a permanent redirect to the unprefixed path rather than served twice. A prefix
 * naming another routed locale is stripped and recorded on `ctx.pathLocale` — and on `ctx.locale`
 * at once, so a 404 for `/en/nothing` renders its error page in the language the URL asked for.
 */
export function routeLocalePrefix(
  pathname: string,
  ctx: RequestContext,
  basePath: string,
): string | Response {
  const prefix = splitLocalePrefix(pathname);
  if (prefix === undefined) return pathname;
  if (prefix.isDefault) {
    const mount = basePath === '/' || basePath === '' ? '' : basePath.replace(/\/$/, '');
    const location = `${mount}${prefix.path}${ctx.url.search}`;
    // PERMANENT, and so not `redirect()`, whose statuses are an application's (it refuses 301 on
    // purpose: a cached permanent redirect cannot be taken back). This one is the framework's URL
    // scheme, and it IS permanent — the default locale is never prefixed, in any release.
    return new Response(null, {
      status: SAFE_METHODS.has(ctx.method) ? 301 : 308,
      headers: { location },
    });
  }
  ctx.pathLocale = prefix.locale;
  ctx.locale = prefix.locale;
  return prefix.path;
}

/**
 * The request's locale. The path first, always; then a route that takes its locale from the path
 * alone gets the DEFAULT for an unprefixed URL — no negotiation, because the document a CDN serves
 * for `/` is one file and cannot vary by header (the bug this rule closes: a `site/` page answered
 * in English to an English browser from the process, and in Spanish from the export). Every other
 * route keeps `resolveLocale`'s own order.
 */
export function requestLocale(ctx: RequestContext, sources: LocaleSources): string {
  if (ctx.pathLocale !== undefined) return ctx.pathLocale;
  if (ctx.route?.meta.localeSource === 'path') return localeConfig().fallback;
  return resolveLocale(sources).locale;
}

/** Whether this response's locale is a function of its URL alone. */
export const localeFromPath = (ctx: RequestContext): boolean =>
  ctx.pathLocale !== undefined || ctx.route?.meta.localeSource === 'path';

/** Removes one dimension from `Vary`, case-insensitively, deleting the header when none is left. */
export const dropVary = (response: Response, name: string): Response => {
  const existing = response.headers.get('vary');
  if (existing === null) return response;
  const kept = existing
    .split(/,\s*/)
    .filter((value) => value !== '' && value.toLowerCase() !== name.toLowerCase());
  if (kept.length === 0) response.headers.delete('vary');
  else response.headers.set('vary', kept.join(', '));
  return response;
};
