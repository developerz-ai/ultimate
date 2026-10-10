/**
 * What an `isr` entry is keyed by: the request URL narrowed to the query the route declared, the
 * negotiated locale, and the way back from a key to the route table. Split from `render-isr.ts`,
 * the controller, which only ever holds the key this file derived.
 */

import { unlocalizedPath } from '@ultimat3/i18n';

/**
 * The reserved query parameter the negotiated locale rides in. A parameter and not a prefix
 * because `routePathOf` splits a key at its `?`: a `es:/blog` key would match no route, so
 * `descriptorFor` would answer `undefined` and a declared `revalidate: { ttl }` would silently
 * become tag-only. Reserved spelling, so an app's own `?locale=` stays its own dimension.
 */
export const ISR_LOCALE_PARAM = '__x_locale';

/**
 * The URL an `isr` route is rendered FOR: the request's, keeping only the query parameters the
 * route declared in `revalidate.query`, one value each, in sorted order.
 *
 * Undeclared (`null`), the key carries the whole query, so `/blog?x=1`, `/blog?x=2`, … are each a
 * miss, a render and a stored entry: any visitor can make an `isr` route render on demand and push
 * real pages out of the bounded store, and `utm_*` / `fbclid` / `gclid` split one page into as
 * many entries as there are campaigns — each of which a withdrawal then has to reach. An `isr`
 * document is a shared artifact, so what it may vary on is the route's to declare, never the
 * visitor's to choose. `null` is kept only because flipping it changes what a page that reads an
 * undeclared parameter renders, and that waits for a major; `query: []` is the safe declaration.
 *
 * The SAME narrowed URL is what `load`, `meta` and the page are given (`data.url`, `props.query`),
 * so a parameter that is not in the key cannot change the document stored under it. Nothing is
 * redirected: `/blog?utm_source=x` is answered with the `/blog` entry, whose `canonical` is `/blog`.
 * A repeated parameter keeps its FIRST value — `?p=1&p=2` and `?p=1&p=3` are one entry, not two.
 */
export function isrRequestUrl(url: URL, query: readonly string[] | null): URL {
  if (query === null) return url;
  const kept = new URLSearchParams();
  for (const name of [...new Set(query)].sort()) {
    const value = url.searchParams.get(name);
    if (value !== null) kept.set(name, value);
  }
  const narrowed = new URL(url);
  narrowed.search = kept.toString();
  narrowed.hash = '';
  return narrowed;
}

/**
 * The request's parameter names the route did not declare: what `isrRequestUrl` drops — or, for a
 * route that declared nothing (`null`), what a visitor just used to mint a stored page.
 */
export function undeclaredQuery(url: URL, query: readonly string[] | null): readonly string[] {
  const declared = new Set(query ?? []);
  return [...new Set(url.searchParams.keys())].filter((name) => !declared.has(name)).sort();
}

/**
 * The ISR store key for one URL: pathname, the negotiated LOCALE, and the query, **params
 * sorted**. The URL is `isrRequestUrl`'s — already narrowed to the route's declared parameters.
 *
 * Exported because deriving it is the caller's job and there may only be ONE derivation — a
 * server that keyed on `url.pathname` while the store believed it held a whole URL is the shape
 * of #171. Sorting makes `?a=1&b=2` and `?b=2&a=1` one entry rather than two renders of one page.
 *
 * The locale is REQUIRED, and required as an argument rather than read from the ambient context so
 * that every call site has to answer: a document is rendered with `<html lang>` and every `t()` in
 * the request's own locale, so one entry per path served visitor 2 the document negotiated for
 * visitor 1 — for the whole TTL, and with `s-maxage` telling the CDN to do the same. The time zone
 * is deliberately NOT a dimension: it is unbounded where a locale set is declared, and an `isr`
 * page is a shared artifact, so a date on one belongs in an explicit zone the page itself names.
 */
export function isrKey(url: URL, locale: string): string {
  const params = new URLSearchParams(url.search);
  params.set(ISR_LOCALE_PARAM, locale);
  params.sort();
  return `${url.pathname}?${params.toString()}`;
}

/**
 * The path the ROUTE TABLE knows a key by. Every lookup that asks the table a question — the
 * descriptor, and therefore the TTL and the tags — has to undo what the key carries beyond the
 * route, in the order the router does before it matches (`@ultimat3/http`'s `routing` stage):
 *
 * - the query: `descriptorFor('/blog?page=2')` matches no route;
 * - the routed locale prefix: `/en/blog/a` is the `/blog/:slug` route in English. The key KEEPS the
 *   prefix — it is the URL the document was rendered for, `canonical` and all — and the table has
 *   never heard of it. Left on, a prefixed page matched no route: `ttlMs: null` and no tag edge, so
 *   it was fresh forever while the default locale's copy of the same page went stale on schedule.
 *
 * `unlocalizedPath` is i18n's, the one the router's own split is built on: a segment that names no
 * routed locale is left alone, so `/fr/blog` is still no route.
 */
export function routePathOf(key: string): string {
  const query = key.indexOf('?');
  return unlocalizedPath(query === -1 ? key : key.slice(0, query));
}
