/**
 * Projection 3: the typed RPC client. Types come from the action map, paths from
 * the same pure derivation the server uses, so a renamed or mistyped action is a
 * compile error in a Solid component — not a 404 at runtime.
 */
import { UltimateError } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { Action } from './action';
import { ContractDriftError, RpcFailedError } from './errors';
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

export function createClient<TActions extends ActionMap>(options: ClientOptions): Client<TActions> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, '');

  const proxy = new Proxy(
    {},
    {
      get(_target, property: string | symbol) {
        if (typeof property !== 'string') return undefined;
        return (input: unknown, callOptions: CallOptions = {}): Promise<unknown> =>
          call(doFetch, base, options, property, input, callOptions);
      },
    },
  );
  // The proxy realizes the mapped type structurally; TS cannot check a Proxy.
  return proxy as Client<TActions>;
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

/** `application/problem+json` back into the same error the server threw. */
async function toUltimateError(response: Response, name: string): Promise<UltimateError> {
  const body: unknown = await response.json().catch(() => null);
  if (isJsonObject(body) && typeof body['code'] === 'string') {
    return new UltimateError({
      code: body['code'],
      cause: stringOr(body['cause'] ?? body['detail'], `${name} failed with ${response.status}`),
      fix: stringOr(body['fix'], `x actions describe ${name} --json`),
      docs: stringOr(body['docs'], `https://ultimate.dev/errors/${body['code']}`),
    });
  }
  return new RpcFailedError(name, response.status);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
