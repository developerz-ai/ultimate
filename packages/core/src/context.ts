// Single responsibility: the ambient request context. Authz, tracing, locale, tz and the
// service bag reach every layer through AsyncLocalStorage instead of being threaded as
// parameters — otherwise every signature in the framework grows a `ctx` argument twice.

import { AsyncLocalStorage } from 'node:async_hooks';
import { type Actor, anonymousActor } from './actor';
import { type Clock, systemClock } from './clock';
import { UltimateError } from './errors';
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
 */
export interface CtxServices {
  readonly [service: string]: unknown;
}

export interface ServiceBag {
  readonly [service: string]: unknown;
}

export interface Ctx extends CtxServices {
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
  /** Late-bound services, for anything not worth a type augmentation. */
  readonly services: ServiceBag;
}

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
  readonly services?: ServiceBag | undefined;
}

export type CtxPatch = Omit<CtxInit, 'requestId'>;

const storage = new AsyncLocalStorage<Ctx>();

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
  };
  // A registered service (`defineService`) closes over the ctx it is built for — actor, clock,
  // tz — so it has to run HERE, against this exact call's fields, rather than once at boot and
  // be cached: a cached instance would answer every impersonated actor with the first one's
  // tenant. `preview` carries everything a factory may read except a sibling service, which is
  // what stops factories from depending on one another's instances. Explicit `init.services`
  // wins over an auto-installed one of the same name — a test's hand-built mock overrides the
  // real thing on purpose.
  const preview = Object.freeze({ ...explicit, ...fields, services: explicit }) as Ctx;
  const services: ServiceBag = Object.freeze({ ...installedServices(preview), ...explicit });
  const ctx = {
    // Services ride ON the context, not only under `ctx.services`: `CtxServices` exists to be
    // augmented, so `ctx.posts` has to BE the service. Spread first, so a service that collides
    // with a framework field (`actor`, `logger`) loses — it stays reachable as
    // `ctx.services.actor`, and the context's own meaning never depends on what an app named a
    // service. The assertion is the one thing this package cannot prove: an augmentation
    // declares which services exist, only the boot code knows whether it passed them, or
    // registered a factory for them. So a service nothing installed reads as `undefined`
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
  return storage.run(ctx, fn);
}

/** The context, or `undefined` outside a request. Prefer `useContext()` in app code. */
export function tryUseContext(): Ctx | undefined {
  return storage.getStore();
}

export function useContext(): Ctx {
  const ctx = storage.getStore();
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
  return storage.getStore() !== undefined;
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
    signal: patch.signal ?? parent.signal,
    services: { ...carried, ...(patch.services ?? {}) },
  });
  return storage.run(child, fn);
}

/** Resolve a late-bound service. Throws `X_SERVICE_MISSING` rather than returning undefined. */
export function useService<T>(name: string): T {
  const ctx = useContext();
  const service = ctx.services[name];
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

// Every log line inside a request gets the ids for free.
setLoggerContextFields(() => {
  const ctx = storage.getStore();
  return ctx === undefined ? undefined : { requestId: ctx.requestId, traceId: ctx.traceId };
});
