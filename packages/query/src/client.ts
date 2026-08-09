/**
 * The typed read client. Types come from the query's own declaration, the URL from
 * the same pure derivation the server uses, so a renamed query is a compile error
 * in a Solid component rather than a 404 at runtime. Browser-safe on purpose: no
 * server imports, nothing here touches a context, a policy or a database.
 */

import type { InferInput, StandardSchemaV1 } from '@ultimat3/schema';
import { QueryRequestFailedError } from './errors';
import { derivePath } from './naming';
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

/** One query's method — what `query.client()` returns. */
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
    headers: { accept: 'application/json', ...options.headers },
    ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
  };

  const response = await doFetch(url, init);
  if (!response.ok)
    throw new QueryRequestFailedError(name, response.status, await problemOf(response));
  const body: unknown = await response.json();
  return body;
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
