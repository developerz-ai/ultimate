/**
 * The typed read client. Types come from the query's own declaration, the URL from
 * the same pure derivation the server uses, so a renamed query is a compile error
 * in a Solid component rather than a 404 at runtime. Browser-safe on purpose: no
 * server imports, nothing here touches a context, a policy or a database.
 *
 * Rows arrive as JSON and are handed back as parsed, exactly as `rpc` does: a query declares no
 * output schema — row types come from the `SqlSource` its `sql:` returns — so there is nothing
 * here to rehydrate a `Date` with, and an instant reaches a caller as the ISO string
 * `JSON.stringify` wrote. A surface that formats one converts at its own edge.
 */

import { currentSpanContext, traceparent } from '@ultimat3/core';
import type { InferInput, StandardSchemaV1 } from '@ultimat3/schema';
import { QueryRequestFailedError } from './errors';
import { derivePath } from './naming';
import type { Query } from './query';
import { isJsonObject } from './stable';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface QueryClientOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface QueryCallOptions {
  readonly signal?: AbortSignal;
}

/** `feed({ orgId })` with the input schema and the row type both inferred. */
export type QueryClientMethod<TInput extends StandardSchemaV1, TRow extends object> = (
  input: InferInput<TInput>,
  options?: QueryCallOptions,
) => Promise<readonly TRow[]>;

/**
 * Loose constraint on purpose: a map of concrete `Query<TInput, TRow>` values must be
 * assignable to it, while `QueryClient<T>` still recovers each read's own input schema and
 * row type. The mirror of `@ultimat3/action`'s `ActionLike`.
 */
export interface QueryLike {
  readonly kind: 'query';
  readonly name: string;
}

export type QueryMap = Record<string, QueryLike>;

/** `queries.publicPost({ slug })`, with the input schema and the row type both inferred. */
export type QueryClient<TQueries extends QueryMap> = {
  readonly [K in keyof TQueries]: TQueries[K] extends Query<infer TInput, infer TRow>
    ? QueryClientMethod<TInput, TRow>
    : never;
};

/**
 * The typed client for a whole query map: `queryClient<Api['queries']>({ baseUrl })`, the read
 * half of `rpc<Api['actions']>`. A surface that must not import a feature — `site/`, whose one
 * edge into `app/` would be a boundary violation — reaches every registered read through this
 * and the `Api` TYPE, with no module-graph edge and no codegen step.
 *
 * One blessed name, and one implementation underneath it: every method is
 * `queryClientMethodFor`, so the map-wide spelling and `read.client()` can never derive
 * different URLs for the same read.
 */
export function queryClient<TQueries extends QueryMap>(
  options: QueryClientOptions,
): QueryClient<TQueries> {
  const proxy = new Proxy(
    {},
    {
      get(_target, property: string | symbol) {
        // `then` is answered with `undefined` for the same reason a symbol is: `await client`,
        // `Promise.resolve(client)` and returning the client from an async function all read it,
        // and a method there makes the client a thenable that fetches a read named "then" and
        // resolves the await to its rows. No query may be called `then` — it is the one name the
        // language reserves at this seam.
        if (typeof property !== 'string' || property === 'then') return undefined;
        return queryClientMethodFor(property, options);
      },
    },
  );
  // The proxy realizes the mapped type structurally; TS cannot check a Proxy.
  return proxy as QueryClient<TQueries>;
}

/** One query's method — what `query.client()` returns, and what `queryClient` proxies to. */
export function queryClientMethodFor<TInput extends StandardSchemaV1, TRow extends object>(
  name: string,
  options: QueryClientOptions,
): QueryClientMethod<TInput, TRow> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, '');
  // Erased at the wire seam; the row type is this query's by construction.
  return (input, callOptions = {}) =>
    read(doFetch, base, options, name, input, callOptions) as Promise<readonly TRow[]>;
}

async function read(
  doFetch: FetchLike,
  base: string,
  options: QueryClientOptions,
  name: string,
  input: unknown,
  callOptions: QueryCallOptions,
): Promise<unknown> {
  const search = searchOf(input);
  const url = `${base}${derivePath(name)}${search === '' ? '' : `?${search}`}`;
  const init: RequestInit = {
    method: 'GET',
    // `traceHeaders()` before the caller's, so an explicit `traceparent` still wins. Without it a
    // service-to-service read started a fresh root trace on the other side, and "which of my
    // downstreams is slow" was unanswerable across every Ultimate-to-Ultimate hop.
    headers: { accept: 'application/json', ...traceHeaders(), ...options.headers },
    ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
  };

  const response = await doFetch(url, init);
  if (!response.ok)
    throw new QueryRequestFailedError(name, response.status, await problemOf(response));
  const body: unknown = await response.json();
  return body;
}

/** A `traceparent` is `00-<32 hex>-<16 hex>-<2 hex>`, and nothing else may be sent as one. */
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/**
 * The current trace, as the W3C header — or nothing at all. `currentSpanContext()` answers with
 * an empty `spanId` when a request context exists but no span is active, and `00-<trace>--01` is
 * a header every collector drops, so an incomplete context sends none. In a browser there is no
 * ambient context and this is always empty, which is also what keeps a cross-origin read from
 * acquiring a CORS preflight it did not have.
 *
 * `@ultimat3/action`'s client carries the twin of this function: both are tier 3, so neither may
 * import the other — the same reason `naming.ts` is ported rather than shared.
 */
function traceHeaders(): Record<string, string> {
  const context = currentSpanContext();
  if (context === undefined) return {};
  if (!TRACE_ID.test(context.traceId) || !SPAN_ID.test(context.spanId)) return {};
  return { traceparent: traceparent(context) };
}

/**
 * Input as a query string. Keys are sorted so the same input always produces the
 * same URL — a GET is a cache key, and an unstable one caches nothing.
 */
function searchOf(input: unknown): string {
  if (!isJsonObject(input)) return '';
  const params = new URLSearchParams();
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? (value as readonly unknown[]) : [value]) {
      params.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
    }
  }
  return params.toString();
}

/** `application/problem+json`, or nothing when a proxy answered instead of the app. */
async function problemOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  return isJsonObject(body) ? body : {};
}
