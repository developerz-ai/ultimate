// A second door onto routes the app already projects: `Authorization: Bearer` on a prefix
// (`/v1/*`), exposing a declared cut of them, per token. Built OVER existing `Route`s — the
// handler, the policy, the idempotency and the input schema are the ones the `/api` route runs,
// so there is no second projection of an action to drift from the first. What the mount adds is
// the credential (only the bearer token authenticates here; a session cookie reaches nothing), the
// cut (a primitive outside the caller's scopes answers 404, the way MCP answers an unknown tool),
// and a per-token allowance with `RateLimit-*` and `Retry-After`.

import type { Actor, Clock } from '@ultimat3/core';
import { ACTION_PATH_PREFIX, QUERY_PATH_PREFIX, systemClock } from '@ultimat3/core';
import type { RequestContext } from './context';
import { bearerMountInvalid, routeNotFound } from './errors';
import type { RateLimitDecision, RateLimitStore } from './rate-limit';
import { memoryRateLimitStore, toBucket } from './rate-limit';
import { rateLimited } from './rate-limit-errors';
import { rateLimitHeaders } from './rate-limit-headers';
import type { UltimateRequest } from './request';
import type { Route, RouteMeta } from './router';
import { HTTP_METHODS } from './router';

/**
 * What a token resolves to. Structurally `@ultimat3/mcp`'s `ResolvedToken`, so an app hands the
 * ONE resolver its MCP endpoint already uses (`resolveToken`) to this mount unchanged.
 */
export interface BearerCaller {
  readonly actor: Actor;
  /** What the token was issued to do; matched against the mount's `scopes` map. */
  readonly scopes: ReadonlySet<string>;
}

/** `null` for a malformed, unknown, revoked or expired token — all one indistinguishable 401. */
export type BearerResolver = (token: string) => Promise<BearerCaller | null> | BearerCaller | null;

export interface BearerMountRateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface BearerMountInput {
  /** `'/v1'` — lowercase segments; never `/api` or `/_x`, which the framework serves itself. */
  readonly prefix: string;
  /** The projected routes the cut is taken from (`apiRoutes()`): matched by `meta.name`. */
  readonly routes: readonly Route[];
  /**
   * Scope → the primitives it covers, BY NAME — the shape `defineAppMcp({ scopes })` takes, so an
   * app passes one map to both. The union is everything the mount serves; a token sees a
   * primitive only while it carries the scope that names it.
   */
  readonly scopes: Readonly<Record<string, readonly string[]>>;
  readonly resolveToken: BearerResolver;
  /** Requests per window per TOKEN (keyed by a hash of the token itself, never the user). */
  readonly rateLimit?: BearerMountRateLimit | undefined;
  /** Where the per-token buckets live. Defaults to per-process memory; a fleet passes a shared one. */
  readonly rateLimitStore?: RateLimitStore | undefined;
  readonly clock?: Clock | undefined;
}

/** A mount prefix: `/v1`, `/public/v2`. Lowercase segments, no parameters, no trailing slash. */
const PREFIX = /^(\/[a-z0-9][a-z0-9._~-]*)+$/;

/** The namespaces a mount may never shadow. */
const RESERVED = [ACTION_PATH_PREFIX, '/_x'];

/** `Authorization: Bearer <token>`, the only accepted form. No query-string tokens. */
export function bearerTokenOf(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * The path a projected route is served at under `prefix`: its framework namespace (`/api`,
 * `/_x/query`) replaced by the prefix, so `POST /api/create-case` is `POST /v1/create-case` and
 * `GET /_x/query/case-list` is `GET /v1/case-list`. A route outside both keeps its whole path.
 */
export function mountedPath(prefix: string, path: string): string {
  for (const namespace of [QUERY_PATH_PREFIX, ACTION_PATH_PREFIX]) {
    if (path.startsWith(`${namespace}/`)) return `${prefix}${path.slice(namespace.length)}`;
  }
  return `${prefix}${path}`;
}

/** Hex SHA-256 prefix: a per-token key that never stores or logs the token itself. */
const tokenKey = (token: string): string =>
  new Bun.CryptoHasher('sha256').update(token).digest('hex').slice(0, 32);

/**
 * The mounted routes. Refuses at construction (`X_BEARER_MOUNT_INVALID`) a prefix that is not a
 * plain path or would shadow `/api` / `/_x`, a scope naming a primitive no route carries, and two
 * primitives that would land on one mounted path.
 *
 * The last routes returned are the prefix's catch-all (`<prefix>/*rest`, every method), so no
 * path under the prefix answers differently for being served: see `opaquePrefix`.
 */
export function bearerMount(input: BearerMountInput): readonly Route[] {
  const { prefix } = input;
  if (!PREFIX.test(prefix)) {
    throw bearerMountInvalid(prefix, 'the prefix is not a lowercase path like /v1');
  }
  for (const reserved of RESERVED) {
    if (prefix === reserved || prefix.startsWith(`${reserved}/`)) {
      throw bearerMountInvalid(
        prefix,
        `the prefix would shadow ${reserved}, which the framework serves`,
      );
    }
  }

  // name → the scope that covers it. One scope per primitive, as MCP's `withScopes` holds.
  const scopeOf = new Map<string, string>();
  for (const [scope, names] of Object.entries(input.scopes)) {
    for (const name of names) {
      const claimed = scopeOf.get(name);
      if (claimed !== undefined && claimed !== scope) {
        throw bearerMountInvalid(
          prefix,
          `${name} is claimed by two scopes, ${claimed} and ${scope}`,
        );
      }
      scopeOf.set(name, scope);
    }
  }
  const byName = new Map<string, Route[]>();
  for (const route of input.routes) {
    const list = byName.get(route.meta.name) ?? [];
    list.push(route);
    byName.set(route.meta.name, list);
  }
  const missing = [...scopeOf.keys()].filter((name) => !byName.has(name)).sort();
  if (missing.length > 0) {
    throw bearerMountInvalid(prefix, `no projected route is named ${missing.join(', ')}`);
  }

  const bucket =
    input.rateLimit === undefined ? undefined : toBucket(`bearer mount ${prefix}`, input.rateLimit);
  const store = input.rateLimitStore ?? memoryRateLimitStore();
  const clock = input.clock ?? systemClock;
  // The caller each request resolved to, keyed by ITS context — never a module-level slot two
  // concurrent requests could share.
  const callers = new WeakMap<RequestContext, { caller: BearerCaller; key: string }>();

  // One authenticator per mounted route, closed over ITS scope, so the cut is decided in the `auth`
  // stage — before `body` and `authz`. Decided in the handler, an out-of-scope token was answered
  // 422 with the schema's issues or 403 with the policy's reason, both confirming the primitive.
  // `null` is the catch-all's: a scope no token holds, so a valid token is told 404 exactly where
  // an out-of-scope one is, and a missing or bad one gets the same challenge as on a served path.
  const authenticatorOf =
    (scope: string | null): NonNullable<RouteMeta['authenticate']> =>
    async (request, ctx) => {
      const token = bearerTokenOf(request.header('authorization'));
      if (token === null) {
        ctx.headers.set('www-authenticate', 'Bearer');
        return null;
      }
      const caller = await input.resolveToken(token);
      if (caller === null) {
        ctx.headers.set('www-authenticate', 'Bearer error="invalid_token"');
        return null;
      }
      // Hidden, never forbidden: a 403 would confirm the primitive exists to a token that was
      // not issued for it — the enumeration MCP's catalog refuses the same way.
      // And never free: the refusal spends the token's allowance as a served call does (which the
      // handler charges, once, so the two paths never both spend) — else a token walks the cut
      // unmetered, and `RateLimit-*` on one 404 but not another tells hidden from unknown.
      if (scope === null || !caller.scopes.has(scope)) {
        await spend(tokenKey(token), ctx);
        throw routeNotFound(ctx.method, ctx.url.pathname);
      }
      callers.set(ctx, { caller, key: tokenKey(token) });
      return caller.actor;
    };

  const spend = async (key: string, ctx: RequestContext): Promise<void> => {
    if (bucket === undefined) return;
    const decision: RateLimitDecision = await store.take(
      `${prefix}|token:${key}`,
      bucket,
      1,
      clock.now().getTime(),
    );
    for (const [name, value] of Object.entries(rateLimitHeaders(decision, clock.now().getTime()))) {
      ctx.headers.set(name, value);
    }
    // `rateLimited` carries the seconds in `meta`, which the error-map stage turns into
    // `Retry-After` — the same 429 every other limit in the framework answers.
    if (!decision.allowed) throw rateLimited(`${prefix}|token`, decision.retryAfterSeconds);
  };

  const mounted: Route[] = [];
  const seen = new Map<string, string>();
  for (const [name, scope] of [...scopeOf.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const route of byName.get(name) ?? []) {
      const path = mountedPath(prefix, route.path);
      const slot = `${route.method} ${path}`;
      const owner = seen.get(slot);
      if (owner !== undefined) {
        throw bearerMountInvalid(prefix, `${name} and ${owner} would both be served at ${slot}`);
      }
      seen.set(slot, name);
      mounted.push({
        method: route.method,
        path,
        meta: { ...route.meta, auth: 'required', authenticate: authenticatorOf(scope) },
        handler: async (request: UltimateRequest, ctx: RequestContext) => {
          const resolved = callers.get(ctx);
          // The authenticator already answered an out-of-scope token; this is the fail-closed
          // floor for a handler driven without the `auth` stage.
          if (resolved === undefined || !resolved.caller.scopes.has(scope)) {
            throw routeNotFound(ctx.method, ctx.url.pathname);
          }
          await spend(resolved.key, ctx);
          return await route.handler(request, ctx);
        },
      });
    }
  }
  return [...mounted, ...opaquePrefix(prefix, authenticatorOf(null))];
}

/** Every method a client can send. HEAD is GET's (`router.ts`'s `routeFor`), never its own route. */
const CATCH_ALL_METHODS = HTTP_METHODS.filter((method) => method !== 'HEAD');

/**
 * `<prefix>/*rest` for every method, behind the mount's own authenticator. Without it a request
 * with no token answered 401 on a served path and 404 — or 405 naming the served methods — on
 * every other, so an anonymous walk of the prefix listed the cut. 401 with the `Bearer` challenge
 * is the uniform answer because it is the TRUE one for a real client anywhere under the prefix:
 * nothing there is reachable without a token. A static or param route still outranks a wildcard,
 * so the mounted routes, and any route the app serves under the prefix itself, keep answering.
 */
const opaquePrefix = (
  prefix: string,
  authenticate: NonNullable<RouteMeta['authenticate']>,
): readonly Route[] =>
  CATCH_ALL_METHODS.map((method) => ({
    method,
    path: `${prefix}/*rest`,
    meta: { name: `bearer-mount:${prefix}`, auth: 'required', authenticate },
    // Reached only if the authenticator did not run: fail closed, with the miss it stands for.
    handler: (_request: UltimateRequest, ctx: RequestContext) => {
      throw routeNotFound(ctx.method, ctx.url.pathname);
    },
  }));
