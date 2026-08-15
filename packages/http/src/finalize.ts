// The tail of the lifecycle, guarded. `Pipeline.handle` promises a Response to every caller, and
// the recover and finalize stages are the ones with nothing above them to catch a throw. One of three:
// `pipeline.ts` owns the ORDER of the stages, `stages.ts` owns what each one does, this file owns
// the promise.
import { logger } from '@ultimat3/core';
import type { RequestContext } from './context';
import { finalizeFailed } from './errors';
import type { UltimateRequest } from './request';
import { problem } from './response';
import type { Stage } from './stages';

/** Renders whatever sits on `ctx.error` into a Response. Never throws, by construction. */
export type Recover = (request: UltimateRequest, ctx: RequestContext) => Promise<Response>;

/**
 * The recover stage is the single place a throw becomes a status — so a throw INSIDE it (an app's
 * `onError` sink, a `devNotices` producer) has nothing left to render it. Rethrowing would break
 * the one guarantee `handle` makes, so the problem document is built here instead, from the error
 * the request actually hit: the caller is told about the defect it met, and the log line carries
 * the second one.
 */
export const recoverWith =
  (stage: Stage | undefined): Recover =>
  async (request, ctx) => {
    try {
      const rendered = await stage?.run(request, ctx);
      if (rendered !== undefined) return rendered;
    } catch (failure) {
      logger.error(
        `the recover stage threw and cannot render itself [${ctx.requestId}]: ${String(failure)}`,
      );
    }
    return problem(ctx.error, { instance: ctx.url.pathname, requestId: ctx.requestId });
  };

/**
 * Runs every finalize stage, and cannot throw. A stage that refuses the response it was handed —
 * headers that cannot be set, on a `Response.redirect` or anything else the handler built — used
 * to reject `handle()` against its own contract, which leaves the server with no answer at all
 * and the client with whatever the runtime prints. It degrades to the coded 500 instead.
 *
 * Two passes at most. The second runs over the response the failure produced, a fresh problem
 * document whose headers ARE writable, so the request id, CORS and the security headers still
 * reach the client that has to report this. A failure on the second pass keeps its 500 and stops:
 * looping over a response nothing can finish is the same outage with more log lines.
 */
export const runFinalize = async (
  stages: readonly Stage[],
  request: UltimateRequest,
  ctx: RequestContext,
  recover: Recover,
): Promise<void> => {
  for (let pass = 0; pass < 2; pass += 1) {
    let failed = false;
    for (const stage of stages) {
      try {
        const replaced = await stage.run(request, ctx);
        if (replaced !== undefined) ctx.response = replaced;
      } catch (error) {
        // Through the recover stage, never around it: reporting, logging and the dev overlay are
        // its job, and a second reporting call site here is a 500 that pages twice or not at all.
        ctx.error = finalizeFailed(stage.name, error);
        ctx.response = await recover(request, ctx);
        failed = true;
        break;
      }
    }
    if (!failed) return;
  }
};
