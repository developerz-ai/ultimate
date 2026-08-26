// Response constructors. Every response in the framework is built here so that
// content types, charsets and cache semantics are decided once instead of per route.
import { logger } from '@ultimat3/core';
import { TIMEZONE_HEADER } from '@ultimat3/time';
import { toProblem } from './error-facts';

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

/** 301 is absent on purpose: a permanent redirect is a deploy decision, not an app one. */
export type RedirectStatus = 302 | 303 | 307 | 308;

/** 303 after a mutation, 302 otherwise — never 301 from application code. */
export const redirect = (location: string, status: RedirectStatus = 302): Response =>
  new Response(null, { status, headers: { location } });

/**
 * A redirect a handler asked for but could not return — see `redirect.ts`. Kept beside
 * `redirect()` so the intent and the Response it becomes cannot drift on status.
 */
export interface RedirectIntent {
  readonly location: string;
  readonly status: RedirectStatus;
}

/**
 * RFC-9457. The body carries the framework's error contract verbatim: `code`,
 * `cause`, `fix`, `docs`. An agent reading a failed response gets the same three
 * strings a human reads in the terminal.
 */
export const problem = (
  error: unknown,
  meta: {
    instance?: string;
    requestId?: string;
    headers?: Record<string, string>;
    /**
     * `config.dev`. Absent means NOT dev: a degraded path that cannot see the config must not be
     * the one that reveals an unclassified 500's text, and the stage that can see it passes it.
     */
    dev?: boolean;
  } = {},
): Response => {
  const document = toProblem(error, {
    ...(meta.instance === undefined ? {} : { instance: meta.instance }),
    ...(meta.requestId === undefined ? {} : { requestId: meta.requestId }),
    ...(meta.dev === undefined ? {} : { dev: meta.dev }),
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

/** A year, the only age at which `immutable` says anything a shorter one does not. */
const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;

/**
 * RFC-9111 delta-seconds is `1*DIGIT`, so `max-age=NaN` is not a shorter age or a longer one — it
 * is an unparseable directive, and a conforming cache IGNORES a directive it cannot parse. The
 * response then falls back to HEURISTIC caching (a fraction of `Last-Modified`'s age), which is
 * the one behaviour no `CacheHint` ever asked for and the one nothing downstream can detect.
 * `??` guards nullish and `NaN` is not nullish, so an age computed from a timestamp difference or
 * read out of an env value arrives here intact; a fraction (`ms / 1000`) and a negative (a clock
 * that went backwards) are the same unparseable token.
 *
 * The name carries `finite` deliberately: `bun run finite-bounds` recognises a repair by the shape
 * of the CALL, so this screen spelled `deltaSeconds` read as no screen at all.
 *
 * `isDeltaSeconds` is EXPORTED and has exactly two readers, which is the point of it: this one
 * decides what may be WRITTEN, and `route-cache.ts` decides what may be DECLARED. A byte-identical
 * predicate in both files is how the two drift, and a value one accepts and the other drops is a
 * silent hole in the middle — a route that registers cleanly and then emits no age.
 *
 * TOTAL, never a throw: this is the response path, where refusing turns a bad cache hint into a
 * 500. A dropped age is always the SAFER direction — no `s-maxage` means a shared cache falls back
 * to `max-age`, and a `max-age` of 0 means revalidate — so nothing here can lengthen an age the
 * caller did not ask for. The warning is what keeps it from being silent; the fix belongs at the
 * declaration, and `field` names which one.
 */
export const isDeltaSeconds = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const finiteDeltaSeconds = (field: string, value: number): number | undefined => {
  if (isDeltaSeconds(value)) return value;
  logger.warn('http.cache_hint_not_delta_seconds', { field, value: String(value) });
  return undefined;
};

export const cacheControl = (hint: CacheHint): string => {
  if (hint.mode === 'no-store') return 'no-store';
  if (hint.mode === 'immutable') {
    const age = finiteDeltaSeconds(
      'maxAgeSeconds',
      hint.maxAgeSeconds ?? IMMUTABLE_MAX_AGE_SECONDS,
    );
    // 0 rather than the year: a declared age that is not a number is not evidence for the longest
    // age in the file, and an over-long `immutable` is the one cache mistake a purge cannot undo.
    return `public, max-age=${String(age ?? 0)}, immutable`;
  }
  const parts = [
    hint.mode,
    `max-age=${String(finiteDeltaSeconds('maxAgeSeconds', hint.maxAgeSeconds ?? 0) ?? 0)}`,
  ];
  if (hint.mode === 'public' && hint.sMaxAgeSeconds !== undefined) {
    const shared = finiteDeltaSeconds('sMaxAgeSeconds', hint.sMaxAgeSeconds);
    if (shared !== undefined) parts.push(`s-maxage=${String(shared)}`);
  }
  if (hint.staleWhileRevalidateSeconds !== undefined) {
    const stale = finiteDeltaSeconds(
      'staleWhileRevalidateSeconds',
      hint.staleWhileRevalidateSeconds,
    );
    if (stale !== undefined) parts.push(`stale-while-revalidate=${String(stale)}`);
  }
  return parts.join(', ');
};

/**
 * Adds to the cache key without ever replacing it. `Vary` is a set, and two stages contribute to
 * it — the cache stage names the request properties a body depends on, the CORS stage names the
 * origin — so a `set` from the later one silently drops the earlier one's key and a CDN starts
 * serving one variant for all of them.
 */
export const addVary = (response: Response, values: readonly string[]): Response => {
  if (values.length === 0) return response;
  const existing = response.headers.get('vary');
  const merged = new Set([...(existing === null ? [] : existing.split(/,\s*/)), ...values]);
  response.headers.set('vary', [...merged].join(', '));
  return response;
};

/**
 * The request dimensions a SHARED copy of a response is keyed on. `cookie` because every session
 * in this framework travels in one; `accept-language` and the time-zone header because both are
 * ambient inputs to a server render — they become `ctx.locale` and `ctx.tz`, which is what
 * `@ultimat3/ui` formats every date with — so the body is a function of them and a cache that
 * ignores one hands the next visitor the previous one's document. One list, two readers: the hint
 * this file applies, and the `cache-headers` stage for a shared `cache-control` a handler wrote.
 */
export const SHARED_CACHE_VARY: readonly string[] = ['accept-language', 'cookie', TIMEZONE_HEADER];

/** Mutates the response headers in place — responses are per-request, never shared. */
export const applyCacheHeaders = (response: Response, hint: CacheHint): Response => {
  response.headers.set('cache-control', cacheControl(hint));
  if (hint.tags !== undefined && hint.tags.length > 0) {
    response.headers.set('x-cache-tags', hint.tags.join(','));
  }
  // `cookie` is not optional on the shared path. A `public` response is stored by a CDN under the
  // URL, and every session in this framework travels in a cookie — so without it the first
  // signed-in render of a public page is what every later visitor is served. `SHARED_CACHE_VARY`
  // rather than a literal: the stage that reviews a handler's own `cache-control` adds the same
  // dimensions, and two lists is one of them missing the key that mattered.
  return addVary(response, hint.vary ?? (hint.mode === 'public' ? SHARED_CACHE_VARY : []));
};

export const withHeaders = (response: Response, headers: Record<string, string>): Response => {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
};
