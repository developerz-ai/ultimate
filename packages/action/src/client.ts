/**
 * Projection 3: the typed RPC client. Types come from the action map, paths from
 * the same pure derivation the server uses, so a renamed or mistyped action is a
 * compile error in a Solid component — not a 404 at runtime.
 *
 * `ClientFlight` is a TYPE here and never a value: the fence, the retry loop and the deadline are
 * `@ultimat3/core`'s `client-flight.ts`, so a caller that never calls `createClientFlight` does
 * not pay a byte for any of them — an `import type` is erased and the value import would not be.
 * Dedup is deliberately unreachable from this file — a mutation may never join another mutation,
 * and the way that is guaranteed is that `keyFor` is never called here.
 */
import type { ClientFlight, ClientRetry, UltimateError, WireAnswer } from '@ultimat3/core';
import { FRAMEWORK_CODE, problemOf, traceHeaders } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { Action } from './action';
import { ContractDriftError, RemoteActionError, RpcFailedError } from './errors';
import { derivePath } from './naming';
import { BUILD_ID_HEADER, IDEMPOTENCY_HEADER } from './wire-headers';
import { issuesFromWire } from './wire-issues';

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
  /**
   * Retry THIS call. Honoured only alongside an `idempotencyKey`, and silently narrowed to one
   * attempt without one — a retried mutation with no key is a second write, not a second attempt,
   * and the framework has no way to tell a lost answer from a lost request.
   */
  readonly retry?: ClientRetry;
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
  /**
   * Opt-in flight control — `createClientFlight({ … })`. Absent, a call is one `fetch` and nothing
   * else, which is what every caller written before this option existed already gets.
   */
  readonly flight?: ClientFlight;
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

/** One attempt, and no retry at all. What a mutation carrying no idempotency key is allowed. */
const ONCE: ClientRetry = { attempts: 1 };

async function call(
  doFetch: FetchLike,
  base: string,
  options: ClientOptions,
  name: string,
  input: unknown,
  callOptions: CallOptions,
): Promise<unknown> {
  const url = `${base}${derivePath(name).path}`;
  const body = JSON.stringify(input ?? {});
  const dispatch = (signal: AbortSignal | undefined): Promise<WireAnswer> =>
    postOnce(doFetch, url, body, options, name, callOptions, signal ?? callOptions.signal);

  const flight = options.flight;
  const answer =
    flight === undefined
      ? await dispatch(undefined)
      : await flight.run({
          // `undefined`, unconditionally: a mutation may never join another mutation, and the
          // enforcement is that this file never calls `flight.keyFor`.
          key: undefined,
          // NEVER aborted. A fence bump and a deadline both mean "this answer no longer matters";
          // closing the socket does not un-commit the write, it only destroys the one chance this
          // caller had of learning whether it landed.
          abortable: false,
          retry: callOptions.idempotencyKey === undefined ? ONCE : (callOptions.retry ?? ONCE),
          run: dispatch,
        });
  if (answer.status === 204) return undefined;
  return JSON.parse(answer.text) as unknown;
}

/** One dispatch. Everything above it decides how many times this happens; it decides none. */
async function postOnce(
  doFetch: FetchLike,
  url: string,
  body: string,
  options: ClientOptions,
  name: string,
  callOptions: CallOptions,
  signal: AbortSignal | undefined,
): Promise<WireAnswer> {
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
    body,
    ...(signal === undefined ? {} : { signal }),
  };
  const response = await doFetch(url, init);
  assertSameBuild(options.buildId, response.headers.get(BUILD_ID_HEADER), name);
  // Read as TEXT once: a `Response` body is a single-use stream, so the failure path and the
  // answer path cannot both have it.
  const text = response.status === 204 ? '' : await response.text();
  if (!response.ok) throw toUltimateError(text, response.status, name);
  return { status: response.status, text };
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
 * `application/problem+json` back into the error the server threw. The code rides along
 * verbatim — carrying one is the point of the document — but it is a code this bundle may never
 * have registered, so the result is a `RemoteActionError`: marked remote-origin, and linked only
 * to a page that exists. A body naming no framework code is a proxy answering rather than the
 * app, which is what `RpcFailedError` already says.
 */
function toUltimateError(text: string, status: number, name: string): UltimateError {
  // `problemOf` is total — a gateway's HTML, an empty body and a truncated stream all answer `{}`,
  // which carries no `code` and therefore lands on `RpcFailedError` exactly as before.
  const body = problemOf(text);
  const code = body['code'];
  if (typeof code !== 'string' || !FRAMEWORK_CODE.test(code)) {
    return new RpcFailedError(name, status);
  }
  return new RemoteActionError({
    action: name,
    status,
    code,
    // Parsed, never taken: `body` is whatever answered the request. A list this build cannot read
    // is dropped rather than repaired, and `cause` below still carries every rejection in it.
    issues: issuesFromWire(body['issues']),
    cause: stringOr(body['cause'] ?? body['detail'], `${name} failed with ${status}`),
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
