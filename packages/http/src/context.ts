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
import { noRequest } from './errors';
import type { AuthzDecision } from './hooks';
import { readCookie } from './locale';
import type { RateLimitDecision } from './rate-limit';
import type { CacheHint, RedirectIntent } from './response';
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
  /**
   * The INBOUND headers, the request's own. Headers and not the `Request`: they are the only
   * part of a request that is already fully read, immutable and safe to hand out. The body is
   * not — `UltimateRequest` size-caps it, parses it by content-type and caches the result, and a
   * raw `Request` on the context would be a second body reader past all three. Set once at
   * construction; a context built outside a request (a job, a test) carries an empty `Headers`.
   */
  readonly requestHeaders: Headers;

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
  /**
   * The one slot app code fills rather than a stage: `setRedirect()` records that this call
   * should answer with a `Location` instead of its return value, and the route projection that
   * generated the handler reads it back with `takeRedirect()`. An action has no way to return a
   * `Response` — its return value is its output schema — so a side channel is the only place
   * "answer 303" can live without a second return protocol.
   */
  redirect: RedirectIntent | undefined;
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
  /** The inbound headers. Absent means "not an HTTP request" and reads as empty. */
  readonly requestHeaders?: HeadersInit;
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
  requestHeaders: new Headers(init.requestHeaders),
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
  redirect: undefined,
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

/**
 * The ambient context, proven to be an HTTP request's rather than a job's or a task's.
 * `requestHeaders` is the discriminator because it is the one field only the pipeline sets, and
 * core's `Ctx` is frozen — so without this a write to a request-only slot is a bare
 * `TypeError: object is not extensible`, which is not an instruction. Not exported from the
 * package: callers want a header, a cookie or a redirect, never the proof.
 */
export const assertInRequest = (member: string, ctx = useRequestContext()): RequestContext => {
  if ((ctx.requestHeaders as Headers | undefined) === undefined) throw noRequest(member);
  return ctx;
};

/**
 * The inbound headers of the request in scope. `use*` because it reads core's ALS, like
 * `useContext` and `useService` — an action handler and a page get a `Ctx`, never the
 * `UltimateRequest`, so an ambient reader is the only seam that reaches them both.
 *
 * Throws rather than answering `null` off a job's context: "there is no request here" and
 * "the caller sent no such header" are different facts, and folding them into one is how a
 * job silently authenticates as nobody.
 */
export const useRequestHeaders = (): Headers => assertInRequest('request headers').requestHeaders;

export const useRequestHeader = (name: string): string | null => useRequestHeaders().get(name);

/** The one way app code reads a cookie the browser sent — a session cookie included. */
export const useRequestCookie = (name: string): string | null =>
  readCookie(useRequestHeaders().get('cookie'), name);

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
