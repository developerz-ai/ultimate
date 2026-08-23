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
 * The answer when even rendering the problem document failed. Literals and one `new Response`,
 * calling nothing that could fail in turn — a last resort that shares a code path with the thing
 * that just broke is not one. Restating the RFC-9457 shape here is the cost of that: the client
 * still gets a document its parser understands, with a code it can look up.
 */
const lastResort = (): Response =>
  new Response(
    JSON.stringify({
      // Spelled out rather than built: this function calls nothing, which is what "last resort"
      // means. `problemTypeFor('X_INTERNAL')` is the one it must equal, and
      // `pipeline-finalize.test.ts` asserts that equality so the two cannot drift apart in silence.
      type: 'urn:ultimate:error:X_INTERNAL',
      title: 'unhandled server error',
      status: 500,
      detail: 'the error renderer itself failed, so nothing of the original error survives here',
      code: 'X_INTERNAL',
      cause: 'the error renderer itself failed, so nothing of the original error survives here',
      fix: 'grep the logs for pipeline.problem_failed — it carries the renderer failure this reply could not',
    }),
    {
      status: 500,
      headers: {
        'content-type': 'application/problem+json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );

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
      // FIELDS, never interpolation — and this is the file whose one promise is that it cannot
      // itself throw. `String(failure)` runs the value's own coercion, so a null-prototype object
      // (`Cannot convert object to primitive value`) or a `Proxy` threw a SECOND time out of the
      // guard, and `handle`'s "always resolves to a Response" died in the one frame with nothing
      // above it. `logger.emit` degrades a hostile field per key and never rethrows, which is
      // exactly what a value nobody here built needs; it is also the shape `error-map` already
      // uses, so the value stays redactable by key.
      logger.error('pipeline.recover_failed', { requestId: ctx.requestId, error: failure });
    }
    // INSIDE a guard, not beside it — and that is this file's whole promise. The line renders a
    // value nobody here built, so "never throws" rested on every reader below it being total, and
    // one was not: `statusFor` read `ERROR_STATUS['toString']` off the prototype chain and handed
    // `new Response(body, { status })` a function, so an app throwing `{ code: 'toString' }` made
    // `handle()` REJECT from the one frame with nothing above it. That read is fixed in
    // `error-map.ts`; this guard is what keeps the contract from depending on the next one.
    try {
      return problem(ctx.error, { instance: ctx.url.pathname, requestId: ctx.requestId });
    } catch (failure) {
      // No `ctx` read in this branch, deliberately: it is reached because reading `ctx` or the
      // value on it threw, so reaching for one more field is how a guard throws out of the guard.
      // `logger.emit` degrades a hostile field per key and never rethrows.
      logger.error('pipeline.problem_failed', { error: failure });
      return lastResort();
    }
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
