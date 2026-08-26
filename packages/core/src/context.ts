// Single responsibility: the ambient request context. Authz, tracing, locale, tz and the
// service bag reach every layer through AsyncLocalStorage instead of being threaded as
// parameters — otherwise every signature in the framework grows a `ctx` argument twice.
//
// THERE IS EXACTLY ONE ASSERTION IN THIS FILE AND IT IS IRREDUCIBLE (`As of 2026-08-24`). It is
// the `as Ctx` in `createContext`, and it is the LAST one: the second — over `preview` — is gone,
// because `CtxFacts` gives that value an honest type, and `@ultimat3/http`'s
// `createRequestContext` now composes this function instead of building a second context beside
// it, so that package has none at all.
//
// Why the last one cannot go. `Ctx extends CtxServices`, and `CtxServices` is the seam an app
// augments (`declare module '@ultimat3/core'`) to declare `ctx.posts`. Those members are
// therefore REQUIRED of any value typed `Ctx` — and this function cannot obtain them: they arrive
// through `init.services`, a `ServiceBag` with a string index signature, and through
// `installedServices()`, which returns the same. No function can return a value of a type whose
// required members it has no way to hold, and no type operator can separate an augmented member
// from a core one either — the index signature makes `keyof Ctx` `string`, so every `Omit` over it
// removes everything.
//
// Four alternatives were built and measured before this line was kept. Making the augmented half
// `Partial<CtxServices>` removes the assertion and turns `ctx.posts` into `PostRepo | undefined`
// for every app — true, and a breaking change to the documented seam. Requiring `CtxInit.services`
// to be a `CtxServices` moves the proof to the caller and breaks every internal `createContext()`
// in an app's program, because an app typechecks the framework's sources through its project
// references. A generic `createContext<S>` returns a context no framework caller can pass where a
// `Ctx` is wanted. And an overload whose implementation signature returns the looser type compiles
// only through TypeScript's documented bivariance hole — the same assertion, laundered.
//
// So it stays, bounded to that one expression, with `CtxFacts` beside it carrying everything this
// package CAN prove. The structural repair is to `Ctx extends CtxServices` itself and it is a
// major: this comment is the record of why it was not done quietly.

import { type Actor, anonymousActor } from './actor';
import { asyncContext } from './async-context';
import { type Clock, systemClock } from './clock';
import { UltimateError } from './errors';
import { finiteOption } from './finite-option';
import { traceId as newTraceId, uuid } from './ids';
import { type Logger, logger as rootLogger, setLoggerContextFields } from './logger';
import { type Role, resolveRole } from './roles';
import { installedServices, isManagedService } from './service';

/**
 * Augment to attach typed services (`ctx.posts`, `ctx.jobs`, `ctx.mail`):
 *
 * ```ts
 * declare module '@ultimat3/core' {
 *   interface CtxServices { readonly posts: PostRepo }
 * }
 * ```
 *
 * KNOWN GAP, and the one place in this file that axiom 3 does not hold: the index signature
 * below makes `ctx.<anything>` a legal expression typed `unknown`, so a service nobody declared
 * and nobody installed is not a compile error — it is a `TS18046` at its first use, or nothing
 * at all where the value is only passed on. The reference app shipped `ctx.storage.ensureBucket()`
 * against a method that exists in no package for exactly this reason. Closing it means deleting
 * the index signature, which is a breaking change for every app that reaches a service through
 * `ctx` without declaring it, and it makes `ServiceBag`'s late-bound half (`ctx.services['mail']`)
 * the only untyped path — which is what it is for.
 */
export interface CtxServices {
  readonly [service: string]: unknown;
}

export interface ServiceBag {
  readonly [service: string]: unknown;
}

/**
 * Every member the FRAMEWORK sets on a context — core's `Ctx` with the app's `CtxServices`
 * augmentation removed. It exists because a framework function cannot type-check an object literal
 * against a type carrying members only the app's boot knows about: `Ctx extends CtxServices`, an
 * app augments `CtxServices` with `declare module`, and every service it declares then became a
 * REQUIRED member of every context literal in the framework. `@ultimat3/http`'s
 * `createRequestContext` stopped compiling inside `examples/dummy` for exactly that reason
 * (`TS2739: missing posts, orgs`), while the framework's own gate — which augments nothing —
 * stayed green.
 *
 * A service FACTORY is handed this and not a `Ctx`, which is also more honest than what it had:
 * `installedServices` builds the bag, so a factory has never been able to read a sibling service,
 * and the type now says so.
 */
export interface CtxFacts {
  readonly requestId: string;
  /** W3C trace id — the same value crosses HTTP -> job -> live query. */
  readonly traceId: string;
  readonly actor: Actor;
  /** BCP-47 tag. */
  readonly locale: string;
  /** IANA time zone. Never format a date without it. */
  readonly tz: string;
  readonly buildId: string;
  readonly role: Role;
  readonly clock: Clock;
  now(): Date;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /**
   * Epoch milliseconds this request's budget runs out at, or `null` when nothing set one.
   *
   * The value BEHIND `signal`, published as a number because a signal can only say "already over"
   * — and every outbound hop needs to say how much is LEFT. Without it a service called at t=29 of
   * a 30s budget started a fresh 30s of its own: real work, holding a pool slot and a vendor
   * connection, for half a minute after the caller's socket was answered `X_TIMEOUT`. `null` for a
   * job, a task and a CLI command, none of which has a caller waiting on a socket.
   */
  readonly deadlineAt: number | null;
  /** Late-bound services, for anything not worth a type augmentation. */
  readonly services: ServiceBag;
}

/**
 * The context as it EXISTS once a boot's services ride on it: the framework's half plus the app's
 * augmentation. Structurally identical to what `Ctx` has always been — the split above changes
 * nothing a reader sees, and everything a CONSTRUCTOR is asked to prove.
 */
export interface Ctx extends CtxFacts, CtxServices {}

export interface CtxInit {
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly actor?: Actor | undefined;
  readonly locale?: string | undefined;
  readonly tz?: string | undefined;
  readonly buildId?: string | undefined;
  readonly role?: Role | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: Logger | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Epoch ms. `@ultimat3/http`'s `startDeadline` is the one production writer. */
  readonly deadlineAt?: number | undefined;
  readonly services?: ServiceBag | undefined;
}

/**
 * Neither id a child may change. `requestId` because one request is one request however many
 * scopes it opens; `buildId` because a child context is the same DEPLOY — `withChildContext`
 * has always forwarded the parent's, so accepting the key was an option that read as honoured and
 * was dropped in silence. Pinned in `type-pins.ts`.
 */
export type CtxPatch = Omit<CtxInit, 'requestId' | 'buildId'>;

/**
 * `async-context.ts` owns why this is a lazily-opened seam rather than a module-scope
 * `new AsyncLocalStorage()`, and why a browser gets `undefined` from a read and an error from a
 * write. It is the same seam `telemetry.ts` and `impersonate.ts` open, on purpose: one answer.
 */
const requestContext = asyncContext<Ctx>('the request context');

const neverAborted = new AbortController().signal;

export const DEFAULT_LOCALE = 'en';
export const DEFAULT_TIME_ZONE = 'UTC';

function buildId(): string {
  return process.env['BUILD_ID'] ?? 'dev';
}

export function createContext(init: CtxInit = {}): Ctx {
  const clock = init.clock ?? systemClock;
  const requestId = init.requestId ?? uuid(clock);
  const trace = init.traceId ?? newTraceId();
  const base = init.logger ?? rootLogger;
  const explicit: ServiceBag = Object.freeze({ ...(init.services ?? {}) });
  const fields = {
    requestId,
    traceId: trace,
    actor: init.actor ?? anonymousActor(),
    locale: init.locale ?? DEFAULT_LOCALE,
    tz: init.tz ?? DEFAULT_TIME_ZONE,
    buildId: init.buildId ?? buildId(),
    role: init.role ?? resolveRole(),
    clock,
    now: () => clock.now(),
    logger: base.child({ requestId, traceId: trace }),
    signal: init.signal ?? neverAborted,
    deadlineAt: screenDeadline(init.deadlineAt),
  };
  // A registered service (`defineService`) closes over the ctx it is built for — actor, clock,
  // tz — so it has to run HERE, against this exact call's fields, rather than once at boot and
  // be cached: a cached instance would answer every impersonated actor with the first one's
  // tenant. `preview` carries everything a factory may read except a sibling service, which is
  // what stops factories from depending on one another's instances. Explicit `init.services`
  // wins over an auto-installed one of the same name — a test's hand-built mock overrides the
  // real thing on purpose.
  const preview: CtxFacts = Object.freeze({ ...explicit, ...fields, services: explicit });
  const services: ServiceBag = Object.freeze({ ...installedServices(preview), ...explicit });
  const ctx = {
    // Services ride ON the context, not only under `ctx.services`: `CtxServices` exists to be
    // augmented, so `ctx.posts` has to BE the service. Spread first, so a service that collides
    // with a framework field (`actor`, `logger`) loses — it stays reachable as
    // `ctx.services.actor`, and the context's own meaning never depends on what an app named a
    // service. The `as Ctx` below is the file's ONE assertion and the header says why it cannot
    // be removed: an augmentation declares which services exist, only the boot code knows whether
    // it passed them or registered a factory for them, and a `ServiceBag` cannot prove either.
    // So a service nothing installed reads as `undefined`
    // through `ctx.posts` — this is a frozen plain object, and it stays one on purpose: a
    // get-trap proxy that threw on absent keys would also throw on `await ctx` (the runtime
    // probes `.then`), on `JSON.stringify`, and on every optional-property check.
    // `useService(name)` is the path that names the failure instead of leaving a bare
    // `TypeError` at the first call: it throws `X_SERVICE_MISSING`, with the installed names
    // and the fix.
    ...services,
    ...fields,
    services,
  } as Ctx;
  return Object.freeze(ctx);
}

export function runWithContext<T>(ctx: Ctx, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

/** The context, or `undefined` outside a request. Prefer `useContext()` in app code. */
export function tryUseContext(): Ctx | undefined {
  return requestContext.get();
}

export function useContext(): Ctx {
  const ctx = tryUseContext();
  if (ctx === undefined) {
    throw new UltimateError({
      code: 'X_NO_CONTEXT',
      cause: 'useContext() was called outside of runWithContext()',
      fix: 'wrap the entry point in runWithContext(createContext({ ... }), fn)',
    });
  }
  return ctx;
}

export function hasContext(): boolean {
  return tryUseContext() !== undefined;
}

/**
 * The tighter of two instants, where absent means "no bound" — the bounded form
 * `lifecycle.ts`'s drain budget uses, over two optional values instead of one. Returns
 * `undefined` rather than `null` because that is what `CtxInit.deadlineAt` spells.
 */
function earliest(left: number | undefined, right: number | null | undefined): number | undefined {
  if (left === undefined) return right ?? undefined;
  if (right === undefined || right === null) return left;
  return Math.min(left, right);
}

/**
 * The one screen over `deadlineAt`, at both boundaries that can set it. A deadline is an instant,
 * not a count, so `finiteOption` rather than `finiteCount` — a clock epoch is legitimately large
 * and a test clock's is legitimately small.
 *
 * WHY IT IS REFUSED AND NOT CLAMPED, in this file specifically: `Math.min` PROPAGATES `NaN`, so one
 * non-finite side poisons the child's deadline as well as its own. `remainingBudgetMs` then asks
 * `left >= 1` of a `NaN`, gets `false`, and answers `undefined` — the same answer it gives for "no
 * deadline at all". So the `x-request-timeout-ms` header is silently omitted and the next hop falls
 * back to its OWN configured budget, which `request-budget.ts`'s own header calls "the exact
 * failure this header exists to prevent". A deadline that quietly stops bounding anything is the
 * dangerous direction, and it is the direction `??` cannot see, because `NaN` is not nullish.
 */
function screenDeadline(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  return finiteOption('the request context', 'deadlineAt', value);
}

/**
 * Derive a narrowed context — impersonation, a locale switch, a per-step abort signal.
 * `requestId` is deliberately not patchable: one request, one id.
 */
export function withChildContext<T>(patch: CtxPatch, fn: () => T): T {
  const parent = useContext();
  // A factory-managed service was built for the PARENT's actor; forwarding it verbatim into an
  // impersonated child would answer every call with the parent's tenant. `createContext` below
  // rebuilds every registered factory fresh against the child's own actor, so only services no
  // factory owns — a hand-built mock nothing registered — carry forward unrebuilt.
  const carried = Object.fromEntries(
    Object.entries(parent.services).filter(([name]) => !isManagedService(name)),
  );
  const child = createContext({
    requestId: parent.requestId,
    traceId: patch.traceId ?? parent.traceId,
    actor: patch.actor ?? parent.actor,
    locale: patch.locale ?? parent.locale,
    tz: patch.tz ?? parent.tz,
    buildId: parent.buildId,
    role: patch.role ?? parent.role,
    clock: patch.clock ?? parent.clock,
    logger: patch.logger ?? parent.logger,
    // One request, one budget: a child scope inherits the deadline for the same reason it
    // inherits `requestId`. A patch may SHORTEN it (a step with its own budget); nothing here
    // lengthens it, because the socket the parent is answering does not move. `??` alone said
    // that and did not do it — a patched hour replaced a parent's second outright, and
    // `remainingBudgetMs` then put the hour on `x-request-timeout-ms` for the next hop.
    deadlineAt: earliest(screenDeadline(patch.deadlineAt) ?? undefined, parent.deadlineAt),
    signal: patch.signal ?? parent.signal,
    services: { ...carried, ...(patch.services ?? {}) },
  });
  return requestContext.run(child, fn);
}

/** Resolve a late-bound service. Throws `X_SERVICE_MISSING` rather than returning undefined. */
export function useService<T>(name: string): T {
  const ctx = useContext();
  // Own keys only, and the SAME read the cause below lists. A raw index walks the prototype, so
  // `useService('constructor')` answered with the `Object` function and the caller's first method
  // call was a bare `TypeError` frames away — which is the failure this function exists to name.
  const service = Object.hasOwn(ctx.services, name) ? ctx.services[name] : undefined;
  if (service === undefined) {
    throw new UltimateError({
      code: 'X_SERVICE_MISSING',
      cause: `"${name}" is not on ctx.services (have: ${Object.keys(ctx.services).join(', ')})`,
      fix: `pass it in createContext({ services: { ${name} } })`,
      meta: { name },
    });
  }
  return service as T;
}

/** Throws `X_ABORTED` if the caller has gone away — call before expensive work. */
export function throwIfAborted(ctx: Ctx = useContext()): void {
  if (!ctx.signal.aborted) return;
  throw new UltimateError({
    code: 'X_ABORTED',
    cause: `request ${ctx.requestId} was aborted by the caller`,
    fix: 'add throwIfAborted(ctx) before expensive work, or pass fetch(url, { signal: ctx.signal }) — the caller is gone, so unwind instead of finishing',
    meta: { requestId: ctx.requestId },
  });
}

/**
 * Every log line inside a request gets the ids for free.
 *
 * Deliberately bounded and deliberately non-PII: ids, kinds and the runtime role, never an email,
 * a name or a token — a log store is not a place to discover you shipped one. What is here is
 * exactly what an incident query needs: `orgId` to scope to a tenant, `actorId` to scope to a
 * user, `role` to scope to a fleet, and `onBehalfOfId` so a line written under impersonation is
 * never mistaken for the customer's own.
 */
setLoggerContextFields(() => {
  const ctx = tryUseContext();
  if (ctx === undefined) return undefined;
  const { actor } = ctx;
  return {
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    role: ctx.role,
    actorKind: actor.kind,
    actorId: actor.id,
    ...(actor.orgId === undefined ? {} : { orgId: actor.orgId }),
    ...(actor.onBehalfOf === undefined ? {} : { onBehalfOfId: actor.onBehalfOf.actorId }),
  };
});
