// Middleware exists for the one thing the pipeline cannot express: wrapping a
// handler (timing, transactions, retries). It is deliberately tiny — the ordered
// pipeline is the blessed extension point, and there is no plugin API before v1.
import type { RequestContext } from './context';
import type { UltimateRequest } from './request';
import type { RouteHandler } from './router';

export type Middleware = (
  request: UltimateRequest,
  ctx: RequestContext,
  next: RouteHandler,
) => Response | Promise<Response>;

/**
 * Left-to-right: `compose([a, b])(handler)` runs `a` outermost. Composition is done
 * once at server start, not per request, so the closure chain is built exactly once.
 */
export const compose =
  (middleware: readonly Middleware[]) =>
  (handler: RouteHandler): RouteHandler =>
    middleware.reduceRight<RouteHandler>(
      (next, current) => (request, ctx) => current(request, ctx, next),
      handler,
    );
