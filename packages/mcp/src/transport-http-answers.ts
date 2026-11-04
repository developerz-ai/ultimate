// What `POST /mcp` answers before it dispatches: the 401, the 403s, the 421, the 429 and the
// per-address failure meter that decides one of them. `{ code, cause, fix }` and a status, never a
// JSON-RPC envelope — nothing was called. Split from `transport-http.ts`, which keeps the order.

import type { Clock, UltimateError } from '@ultimat3/core';
import { proveSameOrigin } from '@ultimat3/core';
import type { Bucket, RateLimitStore } from '@ultimat3/http';
import {
  McpHostRefusedError,
  McpOriginRefusedError,
  McpRateLimitedError,
} from './errors-transport';
import type { JsonRpcResponse } from './wire';

/**
 * Every answer on this route is one caller's: a 401 challenge, a refusal, a JSON-RPC result for
 * the token that asked. `no-store` on all of them (RFC 6750 §3 / RFC 6749 §5.1 for the auth
 * answers), stated HERE because the descriptor is also served bare by `x mcp serve`, where no
 * pipeline stage decides a cache header for it.
 */
export const NO_STORE_HEADERS = { 'cache-control': 'no-store' } as const;
const JSON_HEADERS = { 'content-type': 'application/json', ...NO_STORE_HEADERS } as const;

const refusal = (error: UltimateError, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ code: error.code, cause: error.cause, fix: error.fix }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });

export function json(response: JsonRpcResponse, status: number): Response {
  return new Response(JSON.stringify(response), { status, headers: JSON_HEADERS });
}

/**
 * The refusal, rendered the way this file's 401 and 403 already are. `retry-after` carries the same
 * number the `fix:` line names, because an agent reads one of the two and must not get different
 * answers from them.
 */
export function throttled(verbClass: string, limit: number, retryAfterSeconds: number): Response {
  const error = new McpRateLimitedError({ verbClass, limit, retryAfterSeconds });
  return refusal(error, 429, { 'retry-after': String(retryAfterSeconds) });
}

/**
 * The per-address failure allowance. `refusing` reads the bucket (`RateLimitStore.peek`, which
 * writes nothing) and answers the 429 when not one more failure fits; `spend` charges one
 * failure and answers the 429 when that one did not fit. `undefined` from either: carry on.
 */
export function failureMeter(store: RateLimitStore, bucket: Bucket, clock: Clock) {
  const keyOf = (address: string): string => `mcp:unauthenticated|ip:${address}`;
  const refused = (retryAfterSeconds: number): Response =>
    throttled('unauthenticated', bucket.capacity, retryAfterSeconds);
  return {
    async refusing(address: string | undefined): Promise<Response | undefined> {
      if (address === undefined) return undefined;
      // READ ONLY: this runs on every request, an agent's included, and a write per call would be
      // a Postgres upsert on the hot path of every authenticated one.
      const peek = await store.peek(keyOf(address), bucket, clock.now().getTime());
      return peek.remaining >= 1 ? undefined : refused(peek.retryAfterSeconds);
    },
    async spend(address: string | undefined): Promise<Response | undefined> {
      if (address === undefined) return undefined;
      const spent = await store.take(keyOf(address), bucket, 1, clock.now().getTime());
      return spent.allowed ? undefined : refused(spent.retryAfterSeconds);
    },
  };
}

/**
 * 403 for a present `Origin` that core's `proveSameOrigin` cannot show is this app's, else
 * `undefined`. A missing `Origin` passes: every browser sends one on a POST, a client process none.
 */
export function originRefusal(input: {
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly self: string;
  readonly listed: (origin: string) => boolean;
  readonly path: string;
}): Response | undefined {
  if (input.origin === null) return undefined;
  const verdict = proveSameOrigin({
    selfOrigins: [input.self],
    origin: input.origin,
    secFetchSite: input.secFetchSite,
    listed: input.listed,
    listName: 'http.cors.origins',
  });
  if (verdict.ok) return undefined;
  const error = new McpOriginRefusedError({
    reason: verdict.reason,
    endpoint: `${input.self}${input.path}`,
  });
  return refusal(error, 403);
}

/**
 * `421 Misdirected Request` for a Host a loopback-only server does not serve — "not this server",
 * the truth for a rebound name. The host decides what is loopback; `endpoint` is where it IS.
 */
export function mcpHostRefused(endpoint: string): Response {
  return refusal(new McpHostRefusedError({ endpoint }), 421);
}

export function notAnAgent(): Response {
  return new Response(
    JSON.stringify({
      code: 'X_MCP_PROTOCOL',
      cause: 'resolveToken returned an actor whose kind is not "agent"',
      fix: 'return { kind: "agent", ... } from resolveToken; MCP callers are agents, not users',
    }),
    { status: 403, headers: JSON_HEADERS },
  );
}

export function unauthorized(challenge: string): Response {
  return new Response(
    JSON.stringify({
      code: 'X_MCP_PROTOCOL',
      cause: 'missing or unrecognised bearer token',
      fix: "send Authorization: Bearer <token> with a token the app's resolveToken(token) resolves to { actor, scopes } — it is the only issuer this route has",
    }),
    { status: 401, headers: { ...JSON_HEADERS, 'www-authenticate': challenge } },
  );
}
