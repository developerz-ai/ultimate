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
  const services: ServiceBag = Object.freeze({ ...(init.services ?? {}) });
  const ctx = {
    // Services ride ON the context, not only under `ctx.services`: `CtxServices` exists to be
    // augmented, so `ctx.posts` has to BE the service. Spread first, so a service that collides
    // with a framework field (`actor`, `logger`) loses — it stays reachable as
    // `ctx.services.actor`, and the context's own meaning never depends on what an app named a
    // service. The assertion is the one thing this package cannot prove: an augmentation
    // declares which services exist, only the boot code knows whether it passed them. A missing
    // one throws `X_SERVICE_MISSING` on first use rather than reading as `undefined`.
    ...services,
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
    services: { ...parent.services, ...(patch.services ?? {}) },
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
    fix: 'no action needed — stop work and return',
    meta: { requestId: ctx.requestId },
  });
}

// Every log line inside a request gets the ids for free.
setLoggerContextFields(() => {
  const ctx = storage.getStore();
  return ctx === undefined ? undefined : { requestId: ctx.requestId, traceId: ctx.traceId };
});
