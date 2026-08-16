/**
 * Projection 3: the typed RPC client. Types come from the action map, paths from
 * the same pure derivation the server uses, so a renamed or mistyped action is a
 * compile error in a Solid component — not a 404 at runtime.
 */
import type { UltimateError } from '@ultimat3/core';
import { currentSpanContext, traceparent } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { Action } from './action';
import { ContractDriftError, RemoteActionError, RpcFailedError } from './errors';
import { BUILD_ID_HEADER, IDEMPOTENCY_HEADER } from './http';
import { derivePath } from './naming';
import { isJsonObject } from './stable';

/**
 * Loose constraint on purpose: a map of concrete `Action<In, Out>` values must be
 * assignable to it, while `Client<T>` still recovers each action's exact schemas.
 */
export interface ActionLike {
  readonly kind: 'action';
  readonly name: string;
}

export type ActionMap = Record<string, ActionLike>;

export interface CallOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/** `api.publishPost({ postId })` with both sides of the schema inferred. */
export type Client<TActions extends ActionMap> = {
  readonly [K in keyof TActions]: TActions[K] extends Action<infer TIn, infer TOut>
    ? ClientMethod<TIn, TOut>
    : never;
};

export type ClientMethod<TIn extends StandardSchemaV1, TOut extends StandardSchemaV1> = (
  input: InferInput<TIn>,
  options?: CallOptions,
) => Promise<InferOutput<TOut>>;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  /** Sent on every call; a differing server build id raises X_CONTRACT_DRIFT. */
  readonly buildId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The typed client for a whole action map: `rpc<Api['actions']>({ baseUrl })`. One blessed
 * name — there is no `createClient` twin to choose between.
 */
export function rpc<TActions extends ActionMap>(options: ClientOptions): Client<TActions> {
  const proxy = new Proxy(
    {},
    {
      get(_target, property: string | symbol) {
        // `then` is `undefined` for the same reason a symbol is, and `queryClient` draws the line
        // in the same place: `await client` reads it, so a method there makes the client a
        // thenable that posts an action named "then" and resolves the await to its answer.
        if (typeof property !== 'string' || property === 'then') return undefined;
        return clientMethodFor(property, options);
      },
    },
  );
  // The proxy realizes the mapped type structurally; TS cannot check a Proxy.
  return proxy as Client<TActions>;
}

/**
 * One action's method — what `rpc` proxies to and what `action.client()` returns.
 * Both spellings are the same call, so a per-action client can never drift from the
 * map-wide one.
 */
export function clientMethodFor<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  name: string,
  options: ClientOptions,
): ClientMethod<TInput, TOutput> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, '');
  // Erased at the wire seam; the response type is this action's by construction.
  return (input, callOptions = {}) =>
    call(doFetch, base, options, name, input, callOptions) as Promise<InferOutput<TOutput>>;
}

async function call(
  doFetch: FetchLike,
  base: string,
  options: ClientOptions,
  name: string,
  input: unknown,
  callOptions: CallOptions,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Before the caller's headers, so an explicit `traceparent` still wins. Without this a
    // service-to-service hop started a fresh root trace on the other side, which makes "which of
    // my downstreams is slow" unanswerable across every Ultimate-to-Ultimate call.
    ...traceHeaders(),
    ...options.headers,
  };
  if (options.buildId !== undefined) headers[BUILD_ID_HEADER] = options.buildId;
  if (callOptions.idempotencyKey !== undefined) {
    headers[IDEMPOTENCY_HEADER] = callOptions.idempotencyKey;
  }

  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(input ?? {}),
    ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
  };
  const response = await doFetch(`${base}${derivePath(name).path}`, init);
  assertSameBuild(options.buildId, response.headers.get(BUILD_ID_HEADER), name);
  if (!response.ok) throw await toUltimateError(response, name);
  if (response.status === 204) return undefined;
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
 * ambient context and this is always empty, which is also what keeps a cross-origin GET from
 * acquiring a CORS preflight it did not have.
 *
 * `@ultimat3/query`'s client carries the twin of this function: both are tier 3, so neither may
 * import the other.
 */
function traceHeaders(): Record<string, string> {
  const context = currentSpanContext();
  if (context === undefined) return {};
  if (!TRACE_ID.test(context.traceId) || !SPAN_ID.test(context.spanId)) return {};
  return { traceparent: traceparent(context) };
}

/**
 * Version skew is a contract problem, not a network problem: the client holds
 * types from build A while build B answers. Fail loudly so the shell reloads.
 */
function assertSameBuild(
  clientBuild: string | undefined,
  serverBuild: string | null,
  name: string,
): void {
  if (clientBuild === undefined || serverBuild === null) return;
  if (clientBuild === serverBuild) return;
  throw new ContractDriftError(
    `client build ${clientBuild} called ${name} on server build ${serverBuild}`,
    'reload the page to pick up the new client bundle',
  );
}

/**
 * A framework code, spelled the one way codes are spelled. `typeof code === 'string'` alone
 * accepted `""` and `"error"` — a gateway's JSON body became an `UltimateError` whose code
 * nothing in the framework or the app declares, rendering `: ` under a humanised title.
 */
const FRAMEWORK_CODE = /^X_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/**
 * `application/problem+json` back into the error the server threw. The code rides along
 * verbatim — carrying one is the point of the document — but it is a code this bundle may never
 * have registered, so the result is a `RemoteActionError`: marked remote-origin, and linked only
 * to a page that exists. A body naming no framework code is a proxy answering rather than the
 * app, which is what `RpcFailedError` already says.
 */
async function toUltimateError(response: Response, name: string): Promise<UltimateError> {
  const body: unknown = await response.json().catch(() => null);
  if (!isJsonObject(body)) return new RpcFailedError(name, response.status);
  const code = body['code'];
  if (typeof code !== 'string' || !FRAMEWORK_CODE.test(code)) {
    return new RpcFailedError(name, response.status);
  }
  return new RemoteActionError({
    action: name,
    status: response.status,
    code,
    cause: stringOr(body['cause'] ?? body['detail'], `${name} failed with ${response.status}`),
    fix: stringOr(body['fix'], `x actions describe ${name} --json`),
    // RFC-9457's `type` IS a documentation URI, so a server that sends no `docs` extension has
    // still offered one. Both travel, in preference order: `??` picked `docs` on presence alone,
    // so a `javascript:` one hid a perfectly good `type` behind it. `remoteDocs` takes the first
    // that is an absolute HTTP(S) URL — neither is trusted for being there.
    docs: [nonEmpty(body['docs']), nonEmpty(body['type'])],
  });
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return nonEmpty(value) ?? fallback;
}
