// Single responsibility: the one line a slow request leaves — `http.request.slow` at `warn`, from
// the same accumulator the `Server-Timing` header reads (`request-timings.ts`). No per-request
// access log beside it: the request metric and the trace are that record, and a line per request
// is the log bill nobody reads.

import { SEMCONV } from '@ultimat3/core';
import type { RequestContext } from './context';
import { requestTimings } from './request-timings';

/** The message, a stable key a log query and an alert match on. */
export const SLOW_REQUEST_MESSAGE = 'http.request.slow';

export interface SlowRequestInput {
  readonly status: number;
  /** The route PATTERN or the pipeline's one unmatched label — never the path, which may carry a token. */
  readonly route: string;
  /** `elapsedMs(ctx)` as the `Server-Timing` header was given it: one figure, two readers. */
  readonly totalMs: number;
  /** `http.slowRequestMs`; `0` writes nothing. */
  readonly thresholdMs: number;
}

/**
 * Write the line when this request took at least `thresholdMs`. Fields, never interpolation; the
 * request and trace ids ride `ctx.logger`'s own binding. Answers whether it wrote.
 */
export const logSlowRequest = (ctx: RequestContext, input: SlowRequestInput): boolean => {
  const { status, route, totalMs, thresholdMs } = input;
  if (thresholdMs <= 0) return false;
  if (totalMs < thresholdMs) return false;
  const timings = requestTimings(ctx);
  ctx.logger.warn(SLOW_REQUEST_MESSAGE, {
    [SEMCONV.httpRequestMethod]: ctx.method,
    [SEMCONV.httpRoute]: route,
    [SEMCONV.httpResponseStatusCode]: status,
    durationMs: totalMs,
    thresholdMs,
    ...(timings === undefined
      ? {}
      : {
          gateMs: timings.gateMs,
          handlerMs: timings.handlerMs,
          dbStatements: timings.dbStatements,
          dbMs: timings.dbMs,
          renderMs: timings.renderMs,
          cacheHits: timings.cacheHits,
          cacheMisses: timings.cacheMisses,
        }),
  });
  return true;
};
