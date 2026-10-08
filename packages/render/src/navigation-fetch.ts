/**
 * The client router's one request: the headers the server's navigation gate reads (purpose, the
 * document's `<app>:<surface>`, its principal, its build on a GET), `redirect: 'manual'` so no
 * redirect is followed behind the router's back, `cache: 'no-cache'` so the browser's HTTP cache
 * never answers, and the answer read ONCE into an `Answer` — the page's text, or a non-page's
 * bytes to hand over (a prefetch's are dropped unread).
 */

import {
  CLIENT_BUILD_META,
  CLIENT_NAVIGATION_HEADER,
  CLIENT_NAVIGATION_LOCATION_HEADER,
  CLIENT_NAVIGATION_SCOPE_HEADER,
  CLIENT_NAVIGATION_SURFACE_HEADER,
  CLIENT_SCOPE_META,
} from '@ultimat3/core/page';
import type { NavigationCache } from './navigation-cache';
import { NAVIGATION_META, type ResponseFacts, reusable } from './navigation-rules';

/** One fetched answer, read once — a prefetch and the click after it share it. */
export interface Answer {
  readonly status: number;
  readonly opaqueRedirect: boolean;
  /** `x-ultimate-location`, resolved against the requested URL. */
  readonly location: string | null;
  readonly contentType: string;
  readonly build: string | null;
  readonly html: string | null;
  readonly noStore: boolean;
  /** A non-page answer's bytes, kept to hand over — never for a prefetch. */
  readonly body: Blob | null;
  readonly disposition: string;
}

export const metaOf = (doc: Document, name: string): string | null =>
  doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;

export function fetchDocument(
  win: Window,
  doc: Document,
  url: string,
  purpose: 'soft' | 'prefetch',
  init: RequestInit = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    accept: 'text/html,application/xhtml+xml',
    [CLIENT_NAVIGATION_HEADER]: purpose,
    [CLIENT_NAVIGATION_SURFACE_HEADER]: metaOf(doc, NAVIGATION_META) ?? '',
  };
  const scope = metaOf(doc, CLIENT_SCOPE_META);
  if (scope !== null) headers[CLIENT_NAVIGATION_SCOPE_HEADER] = scope;
  // GET only: a skewed GET is refused before any route runs; a POST is never refused mid-submit.
  const build = metaOf(doc, CLIENT_BUILD_META);
  if ((init.method ?? 'GET') === 'GET' && build !== null) headers[CLIENT_BUILD_META] = build;
  // `no-cache`: the browser's HTTP cache never answers — a `stale-while-revalidate` page would be
  // swapped in stale after a write, a sign-out or a deploy (#693); the router's cache is the only one.
  return win
    .fetch(url, {
      ...init,
      cache: 'no-cache',
      credentials: 'same-origin',
      redirect: 'manual',
      headers,
    })
    .then(async (response) => {
      const contentType = response.headers.get('content-type') ?? '';
      const opaqueRedirect = response.type === 'opaqueredirect';
      const isHtml = /^\s*text\/html\b/i.test(contentType);
      const html = !opaqueRedirect && isHtml ? await response.text() : null;
      let body: Blob | null = null;
      if (!opaqueRedirect && !isHtml && response.status !== 204) {
        if (purpose === 'prefetch') await response.body?.cancel();
        else body = await response.blob();
      }
      const location = response.headers.get(CLIENT_NAVIGATION_LOCATION_HEADER);
      return {
        status: response.status,
        opaqueRedirect,
        location: location === null ? null : new URL(location, url).href,
        contentType,
        build: response.headers.get(CLIENT_BUILD_META),
        html,
        noStore: /\bno-store\b/i.test(response.headers.get('cache-control') ?? ''),
        body,
        disposition: response.headers.get('content-disposition') ?? '',
      };
    });
}

/**
 * A GET's answer: the prefetch held for `url` when it may stand in for the click (`reusable`), else
 * `fetchAgain()`. Taken out of the cache either way — a held answer answers one click.
 */
export function heldOrFetched(
  cache: NavigationCache<Answer>,
  url: string,
  fetchAgain: () => Promise<Answer>,
): Promise<Answer> {
  const held = cache.peek(url);
  cache.delete(url);
  if (held === undefined) return fetchAgain();
  return held.value.then(
    (answer) =>
      reusable({
        status: answer.status,
        html: answer.html !== null,
        location: answer.location,
        noStore: answer.noStore,
        ageMs: held.ageMs,
      })
        ? answer
        : fetchAgain(),
    fetchAgain,
  );
}

/** What `responseVerdict` reads, off the answer, this document and the next one. */
export function responseFactsOf(
  doc: Document,
  next: Document | null,
  answer: Answer,
  asked: Pick<ResponseFacts, 'method' | 'requested' | 'hops'>,
): ResponseFacts {
  const nextMeta = (name: string): string | null => (next === null ? null : metaOf(next, name));
  return {
    ...asked,
    status: answer.status,
    opaqueRedirect: answer.opaqueRedirect,
    location: answer.location,
    contentType: answer.contentType,
    surface: metaOf(doc, NAVIGATION_META),
    nextSurface: nextMeta(NAVIGATION_META),
    build: metaOf(doc, CLIENT_BUILD_META),
    nextBuild: answer.build ?? nextMeta(CLIENT_BUILD_META),
    scope: metaOf(doc, CLIENT_SCOPE_META),
    nextScope: nextMeta(CLIENT_SCOPE_META),
  };
}
