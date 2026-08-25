// The per-request context. It is created by the pipeline before any user code runs
// and published through core's ALS, which is why nothing in the framework has to
// thread a request object by hand — and why nothing can accidentally skip it.
import {
  type Actor,
  anonymousActor,
  type Clock,
  type Ctx,
  createContext,
  isAnonymous,
  type Logger,
  traceId as newTraceId,
  type Role,
  type ServiceBag,
  systemClock,
  useContext,
  uuid,
} from '@ultimat3/core';
import { localeConfig } from '@ultimat3/i18n';
import { timeConfig } from '@ultimat3/time';
import type { HttpConfig } from './config';
import { noRequest } from './errors';
import type { AuthzDecision } from './hooks';
import { readCookie } from './locale';
import type { PeerIdentity } from './peer-identity';
import type { RateLimitDecision } from './rate-limit';
import type { CacheHint, RedirectIntent } from './response';
import type { Route, RouteParams } from './router';

/**
 * The per-request context, and — through `asCtx` — core's `Ctx` itself.
 *
 * `extends Ctx` again, `As of 2026-08-24`, and it is safe again for one reason: this file no
 * longer BUILDS a `Ctx`, it composes one. `Ctx extends CtxServices`, an app augments
 * `CtxServices` with `declare module` to declare `ctx.posts`, and every service it declared then
 * became a required member of every context literal in the framework — this file failed to
 * compile inside `examples/dummy` with `TS2739: missing posts, orgs` while the framework's own
 * gate, which augments nothing, stayed green. `createRequestContext` now spreads
 * `createContext()`'s result, so the members only an app's boot can supply arrive with it and the
 * literal below is checked in full.
 *
 * The `extends` is therefore back to doing what it was always claimed to do: a member core adds
 * to `Ctx` is set here — by `base` — or this file does not compile. `asCtx` is the identity
 * function and never an assertion; `as unknown as Ctx` is what it used to be, over an object
 * missing `clock`, `now`, `logger`, `signal` and `services`, and every reader threw at runtime.
 * `CtxServices`' index signature is what an app augments; `noPropertyAccessFromIndexSignature`
 * keeps `ctx.typo` a build error all the same.
 */
export interface RequestContext extends Ctx {
  /** `performance.now()` at accept time; used for the server-timing header. */
  readonly startedAt: number;
  readonly url: URL;
  readonly method: string;
  readonly role: Role;
  readonly config: HttpConfig;
  readonly ip: string | null;
  readonly https: boolean;
  /**
   * What the mesh's proxy asserted about the peer's certificate, or `null` — for an untrusted
   * deployment, a missing header and a chain shorter than declared alike. Never an actor:
   * `hooks.authenticate` is the one place an identity becomes `ctx.actor`, through
   * `verifyWorkloadToken()` -> `actorFromService()` in `@ultimat3/auth`.
   */
  readonly peer: PeerIdentity | null;
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

  // --- core's `Ctx`, in full. Set at construction, never by a stage: `asCtx` publishes THIS
  // object through core's ALS, so anything absent here is `undefined` in every handler.
  /**
   * The build of the APP this process serves — core's meaning of the word, and what a job and a
   * request must agree on. NOT what the client claims to be running: that is `clientBuildId`,
   * and the two shared this name until `asCtx` was checked, which published the caller's header
   * to every `ctx.buildId` reader in the framework.
   */
  readonly buildId: string;
  readonly clock: Clock;
  now(): Date;
  /** Request-scoped: a child of the root logger carrying `requestId` and `traceId`. */
  readonly logger: Logger;
  /** Aborted when the caller goes away or the request deadline passes. See `deadline.ts`. */
  readonly signal: AbortSignal;
  /**
   * The instant `signal` will fire at, or `null` with `requestTimeoutMs: 0`. Core's field: a
   * signal can only say "already over", and an outbound hop has to say how much is LEFT.
   */
  readonly deadlineAt: number | null;
  readonly services: ServiceBag;

  // Mutable slots, each filled by exactly one pipeline stage. Kept mutable (and
  // documented) rather than rebuilt per stage so a stage list stays a flat array.
  /** Resolved from the inbound headers before the context exists (`correlation.ts`). */
  requestId: string;
  /** W3C trace id, continued from an inbound `traceparent` — 32 hex, never a UUID. */
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
  /** What the CLIENT says it is running, from `config.buildIdHeader`. `assertBuild()` reads it. */
  clientBuildId: string | null;
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
  /** The caller's span id, from an inbound `traceparent`. Resolved before this call. */
  readonly parentSpanId?: string | null;
  readonly ip?: string | null;
  readonly https?: boolean;
  readonly peer?: PeerIdentity | null;
  /** The inbound headers. Absent means "not an HTTP request" and reads as empty. */
  readonly requestHeaders?: HeadersInit;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** The deadline/disconnect signal. Absent means a request nothing can cancel. */
  readonly signal?: AbortSignal;
  /** `Deadline.deadlineAt` — epoch ms. Absent means this request has no budget. */
  readonly deadlineAt?: number | null;
  readonly services?: ServiceBag;
}

export const createRequestContext = (init: RequestContextInit): RequestContext => {
  const clock = init.clock ?? systemClock;
  const requestId = init.requestId ?? uuid(clock);
  // core's `traceId()`, never `uuid()`: a dashed UUIDv7 is not a 32-hex W3C trace id, and a
  // collector rejects the span that carries one — while the log lines beside it, which quote the
  // same field, look fine. Two ids for one request that cannot be joined.
  const traceId = init.traceId ?? newTraceId();
  // COMPOSED from core's constructor rather than built beside it, and that is what deletes the
  // last cast in this file. `createContext` returns a `Ctx` that already carries the app's
  // `CtxServices` augmentation, so spreading it hands this literal the members only the app's boot
  // could supply — and the return below is checked in full, with nothing asserted anywhere.
  //
  // It is also one constructor for one shape instead of two. This file used to re-derive `clock`,
  // `now`, the logger child, `signal`, `deadlineAt` and the service bag itself, so core could fix
  // any of them and the HTTP surface would keep the old answer — which is exactly what happened to
  // the bag: core has spread services ONTO the context since it shipped and this file never did,
  // so an app declaring `ctx.posts` the documented way read `undefined` over HTTP while
  // `ctx.services.posts` beside it was populated. Composing makes that class of drift unwritable.
  //
  // `defineService` factories now install on this surface too, for the same reason: they are
  // `createContext`'s and this is `createContext`.
  const base = createContext({
    requestId,
    traceId,
    role: init.role,
    // The build this PROCESS serves. The client's claim goes to `clientBuildId` below, where only
    // `assertBuild()` reads it — the two shared this name until `asCtx` was checked.
    buildId: init.config.buildId ?? 'dev',
    // What the request gets before the `locale` stage runs, and what it keeps if the stage is
    // never reached (a refusal in `admit`). The owners' configured fallbacks, never a third one.
    locale: localeConfig().fallback,
    tz: timeConfig().defaultZone,
    clock,
    ...(init.logger === undefined ? {} : { logger: init.logger }),
    // Absent means a request nothing can cancel, which is core's `neverAborted` — the same shape
    // this file kept its own singleton for.
    ...(init.signal === undefined ? {} : { signal: init.signal }),
    // `null` and "not set" are one fact to core, whose own field is `number | null`.
    ...(init.deadlineAt === undefined || init.deadlineAt === null
      ? {}
      : { deadlineAt: init.deadlineAt }),
    ...(init.services === undefined ? {} : { services: init.services }),
  });
  return {
    ...base,
    // Everything below is either this package's own or a core member the PIPELINE rewrites: the
    // mutable slots are re-declared here so a stage can write them, and they must therefore be
    // this object's own properties rather than the frozen base's.
    requestId,
    traceId,
    parentSpanId: init.parentSpanId ?? null,
    startedAt: performance.now(),
    url: init.url,
    method: init.method.toUpperCase(),
    config: init.config,
    ip: init.ip ?? null,
    https: init.https ?? init.url.protocol === 'https:',
    peer: init.peer ?? null,
    headers: new Headers(),
    requestHeaders: new Headers(init.requestHeaders),
    params: {},
    route: undefined,
    actor: anonymousActor(),
    locale: localeConfig().fallback,
    tz: timeConfig().defaultZone,
    clientBuildId: null,
    input: undefined,
    authz: undefined,
    rateLimit: undefined,
    cache: undefined,
    redirect: undefined,
    response: undefined,
    error: undefined,
  };
};

/**
 * The single adapter between the HTTP request context and core's ALS payload. It is a WIDENING
 * the compiler checks, not an assertion: `as unknown as Ctx` here shipped a context missing
 * `clock`, `now`, `logger`, `signal` and `services`, so `ctx.now()` threw on every audited
 * action served over HTTP. Never reintroduce a cast — the type error IS the enforcement.
 */
export const asCtx = (ctx: RequestContext): Ctx => ctx;

/**
 * The ambient `Ctx`, WIDENED to the request shape and not yet proven to be one. Private for that
 * reason: every export below runs it through `assertInRequest` first. The cast is the inverse of
 * `asCtx` and the only one in this file that cannot be a checked widening — core's `Ctx` genuinely
 * does not carry `requestHeaders`, which is precisely what makes the proof necessary.
 */
const ambientContext = (): RequestContext => useContext() as unknown as RequestContext;

/**
 * The ambient context, proven to be an HTTP request's rather than a job's or a task's.
 * `requestHeaders` is the discriminator because it is the one field only the pipeline sets, and
 * core's `Ctx` is frozen — so without this a write to a request-only slot is a bare
 * `TypeError: object is not extensible`, which is not an instruction. Not exported from the
 * package: callers want a header, a cookie or a redirect, never the proof.
 */
export const assertInRequest = (member: string, ctx = ambientContext()): RequestContext => {
  if ((ctx.requestHeaders as Headers | undefined) === undefined) throw noRequest(member);
  return ctx;
};

/**
 * Read the ambient request context. Throws outside a request via core's ALS — and, since a job, a
 * task, a scheduler round and a CLI command all supply an ordinary `Ctx`, throws `X_NO_REQUEST`
 * there too rather than handing back an object whose non-optional fields are `undefined`. That is
 * what it used to do, so the first read (`ctx.requestHeaders.get(...)`) was a bare `TypeError`
 * from a public API. `member` names what the caller was after, so the refusal instructs.
 */
export const useRequestContext = (member = 'the request context'): RequestContext =>
  assertInRequest(member, ambientContext());

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
