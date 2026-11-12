// Single responsibility: the `admit` stage — whether this process takes the request at all. Out of
// `stages.ts` once it grew a third reason to refuse (event-loop lag, beside a stopped process and
// `maxInflight`), so the refusal order is read in one place and the stage table stays under the
// file ceiling.

import { inflightCount, isDraining, lifecycleState } from '@ultimat3/core';
import { assertDeclaredBody } from './body-ceiling';
import type { HttpConfig } from './config';
import type { RequestContext } from './context';
import { draining, overloaded } from './errors';
import { type LagSampler, overloadedByLag } from './lag-shed';
import type { UltimateRequest } from './request';

/**
 * A shed request must say when to come back, or it comes back immediately and the retry storm is
 * the load it was shed to avoid. One second: long enough to matter across a fleet, short enough
 * that a client is not parked past a rolling restart.
 */
const SHED_RETRY_AFTER_SECONDS = '1';

/**
 * Before the trace, the route match, auth, the body — everything. A refusal that costs as much as
 * a served request is not load shedding, and this is the stage that makes "reject 40% fast, serve
 * 60% at p99" expressible at all. `lag` is `undefined` unless `http.shedLagMs` is set: off, the
 * stage reads no sampler and compares nothing.
 */
export const admitRequest = (
  request: UltimateRequest,
  ctx: RequestContext,
  config: HttpConfig,
  lag: LagSampler | undefined,
): undefined => {
  // DRAINING is served, never refused: a request reaching the pipeline mid-drain came in on
  // a kept-alive connection or before the listener closed, and the readiness grace exists so
  // it is answered. `connection: close` moves the client's NEXT request to another pod.
  // Refusing it failed 598 of 7,690 requests in one helm upgrade (kind). Only STOPPED refuses.
  if (lifecycleState() === 'stopped') {
    ctx.headers.set('retry-after', SHED_RETRY_AFTER_SECONDS);
    throw draining();
  }
  if (isDraining()) ctx.headers.set('connection', 'close');
  // A declared body over the transport ceiling is refused before anything reads it.
  assertDeclaredBody(request.raw, ctx.url.pathname, config.maxRequestBodyBytes);
  const ceiling = config.maxInflight;
  // `beginWork()` in `server.ts` counted THIS request before the pipeline was entered, so the
  // ceiling is compared against a number that already includes it.
  if (ceiling > 0 && inflightCount() > ceiling) {
    ctx.headers.set('retry-after', SHED_RETRY_AFTER_SECONDS);
    throw overloaded(inflightCount(), ceiling);
  }
  // The overload the ceiling above cannot see: CPU-bound rendering saturates the loop with few
  // requests in flight, and every one admitted then waits behind all of them.
  const lagMs = lag?.p99Ms() ?? 0;
  if (lagMs > config.shedLagMs && config.shedLagMs > 0) {
    ctx.headers.set('retry-after', SHED_RETRY_AFTER_SECONDS);
    throw overloadedByLag(lagMs, config.shedLagMs);
  }
  return undefined;
};
