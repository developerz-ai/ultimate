// How a served process answers a `render: 'static'` page: a 304 when the browser already holds
// these bytes, and — in the container — the document it rendered the first time, from memory.
// A static page is one file in the export; the served process answering it must not cost a render
// per request, nor a body per revalidation. No other mode comes through here.

import type { UltimateRequest } from '@ultimat3/http';
import { html } from '@ultimat3/http';
import type { RenderResult, RouteEntry } from '@ultimat3/render';
import { etagMatches } from './runtime-storage';

/** A rendered static document: always a string body, never a stream. */
export type StaticResult = RenderResult & { readonly body: string };

/**
 * The entries one process keeps. A static route has no params here and no query, so the real count
 * is routes × locales; the cap is what a forged `Host` (part of the key when the app declares no
 * origin) can cost — past it a page is rendered per request, as before, never refused.
 */
export const STATIC_MEMO_LIMIT = 1024;

/**
 * The BYTES one process keeps, the cache tiers' `maxBytes` idea: a count alone lets 1,024 rotated
 * `Host` headers retain 1,024 whole documents, whatever each weighs. Past it, as past the count, a
 * page is rendered per request.
 */
export const STATIC_MEMO_MAX_BYTES = 32 * 1024 * 1024;

export interface StaticMemo {
  get(key: string): StaticResult | undefined;
  set(key: string, result: StaticResult): void;
  readonly size: number;
  /** UTF-8 bytes of the kept keys and bodies. */
  readonly bytes: number;
}

const encoder = new TextEncoder();
const weigh = (key: string, result: StaticResult): number =>
  encoder.encode(key).byteLength + encoder.encode(result.body).byteLength;

export function createStaticMemo(
  limit: number = STATIC_MEMO_LIMIT,
  maxBytes: number = STATIC_MEMO_MAX_BYTES,
): StaticMemo {
  const kept = new Map<string, { readonly result: StaticResult; readonly weight: number }>();
  let bytes = 0;
  return {
    get: (key) => kept.get(key)?.result,
    set(key, result) {
      // Only a 200 is the page: a loader's 404 or 500 is an answer about one moment.
      if (result.status !== 200) return;
      const held = kept.get(key);
      if (held === undefined && kept.size >= limit) return;
      const weight = weigh(key, result);
      // A replacement gives its old weight back first; one that no longer fits is not kept, and
      // neither is the stale document it would have replaced.
      const after = bytes - (held?.weight ?? 0) + weight;
      if (after > maxBytes) {
        if (held !== undefined) {
          kept.delete(key);
          bytes -= held.weight;
        }
        return;
      }
      kept.set(key, { result, weight });
      bytes = after;
    },
    get size() {
      return kept.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

/**
 * The key a request's document is kept under, or `undefined` when it must be rendered: a query
 * string is part of what `meta` reads (`data.url`), and a dynamic segment is an unbounded set an
 * anonymous visitor chooses. The origin is in the key because canonical and `og:url` are absolute
 * against the request's own when the app declares none.
 */
export function staticMemoKey(
  entry: Pick<RouteEntry, 'config' | 'pattern'>,
  url: URL,
  locale: string,
): string | undefined {
  if (entry.config.render !== 'static') return undefined;
  if (entry.pattern.keys.length > 0 || url.search !== '') return undefined;
  return `${locale}\n${url.origin}${url.pathname}`;
}

/**
 * The document, or a bodiless 304 when `If-None-Match` names its ETag. The 304 repeats the
 * validators and the cache posture (RFC 9110 §15.4.5) and drops `content-type`: it has no content.
 * Only a 200 revalidates — a 404 rendered under `static` is sent whole.
 */
export function staticResponse(request: UltimateRequest, result: StaticResult): Response {
  const etag = result.headers['etag'];
  if (
    result.status === 200 &&
    etag !== undefined &&
    etagMatches(request.header('if-none-match'), etag)
  ) {
    const { 'content-type': _dropped, ...headers } = result.headers;
    return new Response(null, { status: 304, headers });
  }
  return html(result.body, { status: result.status, headers: result.headers });
}
