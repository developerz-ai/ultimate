// Response constructors. Every response in the framework is built here so that
// content types, charsets and cache semantics are decided once instead of per route.
import { toProblem } from './error-map';

type HeaderSource = { readonly headers?: HeadersInit | undefined } | undefined;

const withDefaults = (init: HeaderSource, defaults: Record<string, string>): Headers => {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
};

export const json = <T>(body: T, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: withDefaults(init, { 'content-type': 'application/json; charset=utf-8' }),
  });

export const text = (body: string, init?: ResponseInit): Response =>
  new Response(body, {
    ...init,
    headers: withDefaults(init, { 'content-type': 'text/plain; charset=utf-8' }),
  });

export const html = (markup: string, init?: ResponseInit): Response =>
  new Response(markup, {
    ...init,
    headers: withDefaults(init, { 'content-type': 'text/html; charset=utf-8' }),
  });

/**
 * Streamed responses must never be buffered by an intermediary, otherwise the
 * shell-then-holes render mode degrades to plain SSR without anyone noticing.
 */
export const stream = (
  body: ReadableStream<Uint8Array>,
  init?: ResponseInit & { readonly contentType?: string },
): Response =>
  new Response(body, {
    ...init,
    headers: withDefaults(init, {
      'content-type': init?.contentType ?? 'text/html; charset=utf-8',
      'transfer-encoding': 'chunked',
      'x-accel-buffering': 'no',
    }),
  });

export const noContent = (init?: ResponseInit): Response =>
  new Response(null, { ...init, status: 204 });

/** 303 after a mutation, 302 otherwise — never 301 from application code. */
export const redirect = (location: string, status: 302 | 303 | 307 | 308 = 302): Response =>
  new Response(null, { status, headers: { location } });

/**
 * RFC-9457. The body carries the framework's error contract verbatim: `code`,
 * `cause`, `fix`, `docs`. An agent reading a failed response gets the same three
 * strings a human reads in the terminal.
 */
export const problem = (
  error: unknown,
  meta: { instance?: string; requestId?: string; headers?: Record<string, string> } = {},
): Response => {
  const document = toProblem(error, {
    ...(meta.instance === undefined ? {} : { instance: meta.instance }),
    ...(meta.requestId === undefined ? {} : { requestId: meta.requestId }),
  });
  return new Response(JSON.stringify(document), {
    status: document.status,
    headers: withDefaults(
      { headers: meta.headers },
      {
        'content-type': 'application/problem+json; charset=utf-8',
        // A problem is never cacheable: the next request may well succeed.
        'cache-control': 'no-store',
      },
    ),
  });
};

export interface CacheHint {
  readonly mode: 'no-store' | 'private' | 'public' | 'immutable';
  readonly maxAgeSeconds?: number;
  /** Shared/CDN age. `isr` routes set this and rely on tag purges to revalidate. */
  readonly sMaxAgeSeconds?: number;
  readonly staleWhileRevalidateSeconds?: number;
  /** Cache tags a purge can target; mirrored into `x-cache-tags`. */
  readonly tags?: readonly string[];
  readonly vary?: readonly string[];
}

export const NO_STORE: CacheHint = { mode: 'no-store' };

export const cacheControl = (hint: CacheHint): string => {
  if (hint.mode === 'no-store') return 'no-store';
  if (hint.mode === 'immutable') {
    return `public, max-age=${hint.maxAgeSeconds ?? 31_536_000}, immutable`;
  }
  const parts = [hint.mode, `max-age=${hint.maxAgeSeconds ?? 0}`];
  if (hint.mode === 'public' && hint.sMaxAgeSeconds !== undefined) {
    parts.push(`s-maxage=${hint.sMaxAgeSeconds}`);
  }
  if (hint.staleWhileRevalidateSeconds !== undefined) {
    parts.push(`stale-while-revalidate=${hint.staleWhileRevalidateSeconds}`);
  }
  return parts.join(', ');
};

/** Mutates the response headers in place — responses are per-request, never shared. */
export const applyCacheHeaders = (response: Response, hint: CacheHint): Response => {
  response.headers.set('cache-control', cacheControl(hint));
  if (hint.tags !== undefined && hint.tags.length > 0) {
    response.headers.set('x-cache-tags', hint.tags.join(','));
  }
  const vary = hint.vary ?? (hint.mode === 'public' ? ['accept-language'] : []);
  if (vary.length > 0) {
    const existing = response.headers.get('vary');
    const merged = new Set([...(existing === null ? [] : existing.split(/,\s*/)), ...vary]);
    response.headers.set('vary', [...merged].join(', '));
  }
  return response;
};

export const withHeaders = (response: Response, headers: Record<string, string>): Response => {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
};
