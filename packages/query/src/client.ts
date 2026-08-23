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
 *
 * `ClientFlight` is a TYPE here and never a value: dedup, retry, the deadline and the fence are
 * `@ultimat3/core`'s `client-flight.ts`, and a caller that never calls `createClientFlight` does
 * not pay a byte for any of them — an `import type` is erased and the value import would not be.
 * That erasure is the whole reason two islands in this repo write a bare `fetch` instead of
 * importing a typed client.
 */

import type { ClientFlight, ClientRetry, WireAnswer } from '@ultimat3/core';
import { problemOf, traceHeaders } from '@ultimat3/core';
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
  /**
   * Opt-in flight control for every read this client makes — `createClientFlight({ principal })`.
   * Absent, a read is one `fetch` and nothing else, which is what every caller written before this
   * option existed already gets.
   */
  readonly flight?: ClientFlight;
}

export interface QueryCallOptions {
  readonly signal?: AbortSignal;
  /**
   * Refuse to join an identical read already in flight. The case it exists for: this read exists
   * BECAUSE something just changed, so an answer dispatched before the change is the wrong one.
   * Named for `read.ts`'s `fresh`, which means the same thing one layer down — do not join.
   */
  readonly fresh?: boolean;
  /** Overrides the flight's retry policy for this one read. Ignored with no `flight` installed. */
  readonly retry?: ClientRetry;
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
  const dispatch = (signal: AbortSignal | undefined): Promise<WireAnswer> =>
    fetchOnce(doFetch, url, options, name, signal ?? callOptions.signal);

  const flight = options.flight;
  const answer =
    flight === undefined
      ? await dispatch(undefined)
      : await flight.run({
          key: flight.keyFor(url, callOptions),
          // A caller holding its own signal owns this read's lifecycle: it is neither shared nor
          // aborted by a fence bump, and its signal is the only one that reaches the wire.
          abortable: callOptions.signal === undefined,
          ...(callOptions.retry === undefined ? {} : { retry: callOptions.retry }),
          run: dispatch,
        });
  // Parsed per CALLER, never once per dispatch: N joiners of one deduped read may not be handed
  // one mutable array between them, and the shared value is the immutable body TEXT for that
  // reason alone.
  return JSON.parse(answer.text) as unknown;
}

/** One dispatch. Everything above it decides how many times this happens; it decides none. */
async function fetchOnce(
  doFetch: FetchLike,
  url: string,
  options: QueryClientOptions,
  name: string,
  signal: AbortSignal | undefined,
): Promise<WireAnswer> {
  const init: RequestInit = {
    // `traceHeaders()` before the caller's, so an explicit `traceparent` still wins. Without it a
    // service-to-service read started a fresh root trace on the other side, and "which of my
    // downstreams is slow" was unanswerable across every Ultimate-to-Ultimate hop.
    headers: { accept: 'application/json', ...traceHeaders(), ...options.headers },
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  };

  const response = await doFetch(url, init);
  // Read as TEXT once: a `Response` body is a single-use stream, so the failure path and the row
  // path cannot both have it, and a shared answer has to be something a joiner can re-read.
  const text = await response.text();
  if (!response.ok) throw new QueryRequestFailedError(name, response.status, problemOf(text));
  return { status: response.status, text };
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
