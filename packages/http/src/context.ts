// The per-request context. It is created by the pipeline before any user code runs
// and published through core's ALS, which is why nothing in the framework has to
// thread a request object by hand — and why nothing can accidentally skip it.
import {
  type Actor,
  anonymousActor,
  type Ctx,
  isAnonymous,
  type Role,
  useContext,
  uuid,
} from '@ultimat3/core';
import type { HttpConfig } from './config';
import type { AuthzDecision } from './hooks';
import type { RateLimitDecision } from './rate-limit';
import type { CacheHint } from './response';
import type { Route, RouteParams } from './router';

export interface RequestContext {
  /** `performance.now()` at accept time; used for the server-timing header. */
  readonly startedAt: number;
  readonly url: URL;
  readonly method: string;
  readonly role: Role;
  readonly config: HttpConfig;
  readonly ip: string | null;
  readonly https: boolean;
  /** Response headers accumulated by stages before a Response exists. */
  readonly headers: Headers;

  // Mutable slots, each filled by exactly one pipeline stage. Kept mutable (and
  // documented) rather than rebuilt per stage so a stage list stays a flat array.
  /** Set by the `request-id` stage; seeded so a crash before it still correlates. */
  requestId: string;
  /** Set by the `trace` stage from an inbound `traceparent`, if any. */
  traceId: string;
  parentSpanId: string | null;
  params: RouteParams;
  route: Route | undefined;
  /**
   * Never null: core models "nobody" as the anonymous actor, and `asCtx` publishes this very
   * object through ALS — so a null here would reach every `ctx.actor` reader in the framework
   * as a contract violation that only shows up on the first unauthenticated request.
   */
  actor: Actor;
  locale: string;
  tz: string;
  buildId: string | null;
  input: unknown;
  authz: AuthzDecision | undefined;
  rateLimit: RateLimitDecision | undefined;
  cache: CacheHint | undefined;
  response: Response | undefined;
  error: unknown;
}

export interface RequestContextInit {
  readonly url: URL;
  readonly method: string;
  readonly role: Role;
  readonly config: HttpConfig;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly ip?: string | null;
  readonly https?: boolean;
}

export const createRequestContext = (init: RequestContextInit): RequestContext => ({
  requestId: init.requestId ?? uuid(),
  traceId: init.traceId ?? uuid(),
  startedAt: performance.now(),
  url: init.url,
  method: init.method.toUpperCase(),
  role: init.role,
  config: init.config,
  ip: init.ip ?? null,
  https: init.https ?? init.url.protocol === 'https:',
  headers: new Headers(),
  parentSpanId: null,
  params: {},
  route: undefined,
  actor: anonymousActor(),
  locale: init.config.locale.default,
  tz: init.config.tz.default,
  buildId: null,
  input: undefined,
  authz: undefined,
  rateLimit: undefined,
  cache: undefined,
  response: undefined,
  error: undefined,
});

/**
 * `Ctx` is owned by `@ultimat3/core` and grows service handles by module
 * augmentation. This is the single adapter between the HTTP request context and
 * core's ALS payload, so a change to `Ctx` touches one line of this package.
 */
export const asCtx = (ctx: RequestContext): Ctx => ctx as unknown as Ctx;

/** Read the ambient request context. Throws outside a request via core's ALS. */
export const useRequestContext = (): RequestContext => useContext() as unknown as RequestContext;

export const elapsedMs = (ctx: RequestContext): number =>
  Math.round((performance.now() - ctx.startedAt) * 100) / 100;

/**
 * The fields the HTTP layer reads off an actor. `Actor` is owned by
 * `@ultimat3/core` and extended by the auth adapter, so this narrow view is the
 * only place that assumes anything about its shape.
 */
export interface ActorView {
  readonly id: string;
  readonly orgId?: string | null;
}

/** Anonymous reads as "no actor" so the rate limiter keys an unauthenticated call by IP. */
export const actorView = (actor: Actor | null): ActorView | null =>
  actor === null || isAnonymous(actor) ? null : (actor as unknown as ActorView);
