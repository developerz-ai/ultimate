// What `executeJob` reads off the caller's context, defensively — a context can arrive across a cast
// (`asCtx`, a test's `{} as Ctx`, an app's `WorkerOptions.context()`) without the fields the type
// promises — and whether the worker's drain ended the run. Split from `execute.ts` at its ceiling.

import type { Actor, Ctx, ServiceBag } from '@ultimat3/core';
import { anonymousActor, isUltimateError } from '@ultimat3/core';

/** Stands in for a caller with nothing to cancel, so the composition below has one shape. */
const NEVER_ABORTED = new AbortController().signal;

/**
 * `Ctx.signal` is non-optional in the type and `ctxOf` always sets it — but a context can
 * still arrive across a cast (`@ultimat3/http`'s `asCtx`, a test's `{} as Ctx`) without one, and
 * a job that crashed on a missing field would be a far worse answer than a job with no caller to
 * follow. Read it, do not assume it.
 */
export function callerSignal(ctx: Ctx): AbortSignal {
  return ctx.signal instanceof AbortSignal ? ctx.signal : NEVER_ABORTED;
}

/**
 * The same defensive read, for the same reason: `Ctx.actor` is non-optional in the type and
 * `ctxOf` always sets it, but `WorkerOptions.context()` is the app's own function and a
 * cast context (`{} as Ctx`) reaches here without one. Anonymous is the honest stand-in — it
 * carries no org, so the job's declared tenant is the only thing that can put one on the run.
 */
export function callerActor(ctx: Ctx): Actor {
  const actor: Actor | undefined = ctx.actor;
  return actor === undefined ? anonymousActor() : actor;
}

const NO_SERVICES: ServiceBag = Object.freeze({});

/**
 * The same defensive read a third time, and this one is load-bearing rather than merely kind:
 * `withChildContext` ITERATES the parent's bag to decide what carries forward, so a cast context
 * with no `services` would fail the run with a `TypeError` before the body ever started.
 */
export function callerServices(ctx: Ctx): ServiceBag {
  const services: ServiceBag | undefined = ctx.services;
  return services === undefined ? NO_SERVICES : services;
}

/**
 * The run was cancelled by the worker's drain: the code `JobDrainedError` carries, read off the
 * signal. The FIRST reason wins on a controller, so a timeout that fired before the drain still
 * reports as a timeout — the drain only claims an attempt it ended.
 */
export function drainedBy(signal: AbortSignal): boolean {
  return signal.aborted && isUltimateError(signal.reason) && signal.reason.code === 'X_DRAINING';
}
