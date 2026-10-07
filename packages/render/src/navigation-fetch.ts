/**
 * The client router's one request: the headers the server's navigation gate reads (purpose, the
 * document's `<app>:<surface>`, its principal, its build on a GET), `redirect: 'manual'` so no
 * redirect is followed behind the router's back, and the answer read ONCE into an `Answer` — the
 * page's text, or a non-page's bytes to hand over (a prefetch's are dropped unread).
 */

import {
  CLIENT_BUILD_META,
  CLIENT_NAVIGATION_HEADER,
  CLIENT_NAVIGATION_LOCATION_HEADER,
  CLIENT_NAVIGATION_SCOPE_HEADER,
  CLIENT_NAVIGATION_SURFACE_HEADER,
  CLIENT_SCOPE_META,
} from '@ultimat3/core/page';
import { NAVIGATION_META } from './navigation-rules';

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
  return win
    .fetch(url, { ...init, credentials: 'same-origin', redirect: 'manual', headers })
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
