// Single responsibility: what a failed request owes its observers — the monitor (5xx), the app's
// `onError` sink and one log line — for the `error-map` stage and for a fault that arrives after
// the response left (`reportLateFault`), which that stage can no longer see.

import {
  type Ctx,
  isAnonymous,
  isUltimateError,
  parentContext,
  reportError,
  stringField,
  throwIfAborted,
  tryUseContext,
} from '@ultimat3/core';
import type { RequestContext } from './context';
import { type ErrorFacts, factsOf } from './error-facts';
import type { ServerHooks } from './hooks';
import { refusalLogLevel } from './refusal-log';

/**
 * The one label a request with no matched route may carry. Every 404 and every scan of `/wp-admin`
 * would otherwise be its own rate-limit bucket and its own metric series — an attacker choosing
 * the server's cardinality is how a Prometheus dies. Exported because `pipeline.ts` labels the
 * request metric with it too, and two spellings of "unmatched" is two series.
 */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * True when `error` is the caller's hang-up surfacing: `signal` was aborted with an UNCODED reason
 * (Bun's `AbortError` on a closed socket — a coded one is the deadline or a drain) and the throw is
 * that reason or an `AbortError` raised for it. Any other throw after a hang-up is still a defect.
 */
export const isCallerAbort = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted || isUltimateError(signal.reason)) return false;
  return error === signal.reason || stringField(error, 'name') === 'AbortError';
};

/**
 * The throw the request is answered for: core's `X_ABORTED` (499) in place of a caller's hang-up,
 * else `error` itself. A closed tab is not a 500, and core's `throwIfAborted` is the one place
 * that error is built.
 */
export const answerableError = (error: unknown, ctx: RequestContext): unknown => {
  if (!isCallerAbort(error, ctx.signal)) return error;
  try {
    throwIfAborted(ctx);
  } catch (abortedByCaller) {
    return abortedByCaller;
  }
  return error;
};

/**
 * This package's ONE error-reporting call site, and it is the framework's own — `onError` stays
 * the APP's sink. 5xx only: a 404 or a 422 is the caller's mistake, the problem document already
 * told them, and a monitor that also holds those is a log nobody reads. The `operation` is the
 * route PATTERN for the same reason `recordRequest` uses it.
 */
export const recordFault = (
  hooks: ServerHooks,
  error: unknown,
  ctx: RequestContext,
): ErrorFacts => {
  const facts = factsOf(error);
  const route = ctx.route?.path ?? UNMATCHED_ROUTE;
  if (facts.status >= 500) {
    reportError(error, {
      source: 'http',
      scope: {
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        role: ctx.role,
        operation: `${ctx.method} ${route}`,
        actorId: isAnonymous(ctx.actor) ? undefined : ctx.actor.id,
      },
    });
  }
  hooks.onError?.(error, ctx);
  // FIELDS, never interpolation. `logger.emit()` redacts `bound`, `contextFields` and `fields` —
  // never `msg` — so a cause baked into the message reached the log store past every rule that
  // exists to stop it: a rejected `{"password":"hunter2"}` was logged verbatim, at 4xx, which is
  // logged and not reported and therefore kept for the full retention. The message is the CODE
  // alone; everything variable is a field. The other half is `@ultimat3/schema`'s, and it is the
  // load-bearing one: an issue message must stop echoing the rejected value at all.
  // A refusal logged at `info` (a scanner on the login wall, a 404, a 400, a 422) is counted, and
  // `info` once per route and code per minute — `debug` after (`refusal-log.ts`).
  const level = refusalLogLevel({
    status: facts.status,
    code: facts.code,
    error,
    route,
    nowMs: performance.now(),
  });
  // info: only a 4xx's first line per route and code per minute; every repeat is debug
  ctx.logger[level](facts.code, { cause: facts.cause, status: facts.status });
  return facts;
};

/** request context → its late report; replaced by `SPENT` once a fault has used it. */
const late = new WeakMap<Ctx, (error: unknown) => void>();
const SPENT = (): void => undefined;

/** The pipeline's half: gives `ctx` the hooks a fault after the response is recorded with. */
export const bindLateFault = (ctx: RequestContext, hooks: ServerHooks): void => {
  late.set(ctx, (error) => void recordFault(hooks, error, ctx));
};

/**
 * Records a fault that surfaced after the response was handed over — a streamed body's producer —
 * exactly as the `error-map` stage would have: monitor (5xx), `hooks.onError`, the log line. ONCE
 * per request; a second call records nothing. `false` only when no pipeline request is behind
 * `ctx`: nothing is recorded, since a producer driven outside the pipeline is a test.
 *
 * The caller's hang-up (`isCallerAbort` on `ctx.signal`, which carries every signal a context it
 * was derived inside brought) is not a fault: nobody is there to answer and nothing failed, so it
 * records nothing and leaves the request's one report unspent — and is `false`, like any other
 * call, with no pipeline request behind it. Never throws: nothing is above it.
 */
export const reportLateFault = (
  error: unknown,
  ctx: Ctx | undefined = tryUseContext(),
): boolean => {
  const abandoned = ctx !== undefined && isCallerAbort(error, ctx.signal);
  for (let scope = ctx; scope !== undefined; scope = parentContext(scope)) {
    const record = late.get(scope);
    if (record === undefined) continue;
    // A request IS behind it, so `true` — but a hang-up spends nothing and records nothing.
    if (abandoned) return true;
    late.set(scope, SPENT);
    try {
      record(error);
    } catch (failure) {
      scope.logger.error('pipeline.late_fault_failed', { error: failure });
    }
    return true;
  }
  return false;
};
