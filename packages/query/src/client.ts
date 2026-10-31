/**
 * The typed read client. Types come from the query's own declaration, the URL from
 * the same pure derivation the server uses, so a renamed query is a compile error
 * in a Solid component rather than a 404 at runtime. Browser-safe on purpose: no
 * server imports, nothing here touches a context, a policy or a database.
 *
 * Every read goes through `@ultimat3/core`'s `clientTransport`, the one browser HTTP function —
 * there is no `fetch` call here, only the injected `fetch` option handed on as `fetchImpl`. Rows
 * are handed back as parsed, with every value the server answered as a `Date` revived as one — the
 * route names them in `x-ultimate-dates` (`@ultimat3/core`'s `wire-dates.ts`), so a row typed
 * `Date` is a `Date` here, and never an ISO string to convert. A record envelope is unwrapped by the
 * transport, its rows adopted into the page's store, so the return type is the rows either way.
 *
 * `ClientFlight` is a TYPE here and never a value: dedup, retry, the deadline and the fence are
 * `@ultimat3/core`'s `client-flight.ts`, and a caller that never calls `clientFlight` does
 * not pay a byte for any of them — an `import type` is erased and the value import would not be.
 */

import type { ClientFlight, ClientRetry } from '@ultimat3/core';
import type { FetchLike, RecordEnvelope } from '@ultimat3/core/page';
import { clientTransport, queryPath } from '@ultimat3/core/page';
import type { InferInput, StandardSchemaV1 } from '@ultimat3/schema';
import type { DownloadClientMethod, DownloadQuery } from './download';
import type { PageControls } from './page-controls';
import type { Page } from './pagination';
import type { Query } from './query';
import { searchOf } from './search-string';

/** Core's, re-exported under the name this package always exported it by — one declaration. */
export type { FetchLike } from '@ultimat3/core/page';

export interface QueryClientOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Opt-in flight control for every read this client makes — `clientFlight({ principal })`.
   * Absent, a read is one dispatch and nothing else, which is what every caller written before
   * this option existed already gets.
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
  /**
   * The decoded record envelope, after its rows were adopted — only for a read declaring an
   * entity's `rows:`. The store is keyed and unordered; this is where a caller reads the ORDER.
   * With `adopt: false`, the rows are not adopted; the caller adopts them.
   */
  readonly onEnvelope?: (envelope: RecordEnvelope) => void;
  /** `false`: the rows are handed to `onEnvelope` and NOT adopted — the caller adopts them. */
  readonly adopt?: boolean;
}

/**
 * `feed({ orgId })` with the input schema and the row type both inferred — and `feed.page(...)`,
 * the same read as one bounded page.
 *
 * `page` rides ON the method rather than beside it because the method is what a `queryClient` map
 * hands out per name: `queries.feed.page({ orgId }, { first: 20 })` needs no second map and no
 * second derivation of the URL. Its args are `PaginateArgs` with the server-side options gone —
 * the browser has no `ctx` and no `actor` to hand over; the route decides both.
 */
export interface QueryClientMethod<TInput extends StandardSchemaV1, TRow extends object> {
  (input: InferInput<TInput>, options?: QueryCallOptions): Promise<readonly TRow[]>;
  page(
    input: InferInput<TInput>,
    args: PageControls,
    options?: QueryCallOptions,
  ): Promise<Page<TRow>>;
}

/**
 * A download query's signed URL, as `url()` answers it. `url` is a PATH on the server and absolute
 * from a client with a `baseUrl`; `expiresAt` is an ISO instant — mint again past it.
 */
export interface DownloadUrl {
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * A `single: true` read's method: the route answers the row itself, or 404 `X_NOT_FOUND` — which
 * the transport rejects with, as it does every problem document. No `page`: the route refuses the
 * page controls on a single read, so the method a list read carries would be a guaranteed 400.
 */
export type QuerySingleClientMethod<TInput extends StandardSchemaV1, TRow extends object> = (
  input: InferInput<TInput>,
  options?: QueryCallOptions,
) => Promise<TRow>;

/**
 * The method a read's declaration projects to. DISTRIBUTIVE on purpose: for `boolean` it is the
 * union, so a `Query<I, R, true>` is still assignable where `Query<I, R, boolean>` is asked for.
 */
export type QueryClientMethodOf<
  TInput extends StandardSchemaV1,
  TRow extends object,
  TSingle extends boolean,
> = TSingle extends true ? QuerySingleClientMethod<TInput, TRow> : QueryClientMethod<TInput, TRow>;

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
  readonly [K in keyof TQueries]: TQueries[K] extends DownloadQuery<infer TInput>
    ? DownloadClientMethod<TInput>
    : TQueries[K] extends Query<infer TInput, infer TRow, infer TSingle extends boolean>
      ? QueryClientMethodOf<TInput, TRow, TSingle>
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

/**
 * One query's method — what `query.client()` returns, and what `queryClient` proxies to. It
 * carries `url` too, the download half; the declaration's TYPE decides which half a caller sees.
 */
export function queryClientMethodFor<TInput extends StandardSchemaV1, TRow extends object>(
  name: string,
  options: QueryClientOptions,
): QueryClientMethod<TInput, TRow> {
  return methodsOf<TInput, TRow>(name, options);
}

/**
 * A download query's client half: `url(input)` asks the server to mint. A GET with no `_token` IS
 * the mint, so the request is the plain read's and only the answer — `{ url, expiresAt }` — differs.
 */
export function downloadClientFor<TInput extends StandardSchemaV1>(
  name: string,
  options: QueryClientOptions,
): DownloadClientMethod<TInput> {
  return { url: methodsOf<TInput, object>(name, options).url };
}

/** The rows call, `page` and `url` over one base — `url` typed only on a download's method. */
function methodsOf<TInput extends StandardSchemaV1, TRow extends object>(
  name: string,
  options: QueryClientOptions,
) {
  const base = options.baseUrl.replace(/\/+$/, '');
  // Erased at the wire seam; the row type is this query's by construction.
  const rows = (input: InferInput<TInput>, callOptions: QueryCallOptions = {}) =>
    read(base, options, name, input, callOptions) as Promise<readonly TRow[]>;
  const page = (
    input: InferInput<TInput>,
    args: PageControls,
    callOptions: QueryCallOptions = {},
  ) => read(base, options, name, input, callOptions, args) as Promise<Page<TRow>>;
  const url = async (
    input: InferInput<TInput>,
    callOptions: QueryCallOptions = {},
  ): Promise<DownloadUrl> => {
    const minted = (await read(base, options, name, input, callOptions)) as DownloadUrl;
    return { ...minted, url: base + minted.url };
  };
  return Object.assign(rows, { page, url });
}

/**
 * One read, through `@ultimat3/core`'s `clientTransport` — the one browser HTTP function. It owns
 * the wire: `Accept`, the error decode, the principal fence, and the record envelope — whose rows it adopts
 * into the page's store before handing back `data`, so the return type here never changed. The
 * `fetch` option is the transport's injected `fetchImpl`, never a call made here.
 */
function read(
  base: string,
  options: QueryClientOptions,
  name: string,
  input: unknown,
  callOptions: QueryCallOptions,
  page?: PageControls,
): Promise<unknown> {
  const search = searchOf(input, page);
  return clientTransport({
    method: 'GET',
    url: `${base}${queryPath(name)}${search === '' ? '' : `?${search}`}`,
    // The trace and budget are the transport's, from its server-side outbound slot, placed
    // before these so an explicit `traceparent` still wins; a browser bundles none of it.
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
    ...(options.flight === undefined ? {} : { flight: options.flight }),
    ...(callOptions.fresh === undefined ? {} : { fresh: callOptions.fresh }),
    ...(callOptions.retry === undefined ? {} : { retry: callOptions.retry }),
    ...(callOptions.onEnvelope === undefined ? {} : { onEnvelope: callOptions.onEnvelope }),
    ...(callOptions.adopt === undefined ? {} : { adopt: callOptions.adopt }),
    ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
  });
}
