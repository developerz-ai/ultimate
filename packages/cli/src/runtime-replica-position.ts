// Single responsibility: the replica scope's request frame, and the position it carries. A request
// that wrote answers with the primary's WAL position (`__Host-x-pos` and `x-ultimate-position`);
// a later request that brings it back reads a replica only once that replica has replayed it.

import { logger, renderThrowable } from '@ultimat3/core';
import { db, formatPosition, parsePosition, primaryPosition, withReplicaReads } from '@ultimat3/db';
import {
  type Middleware,
  type RequestContext,
  setCookie,
  type UltimateRequest,
} from '@ultimat3/http';

export const POSITION_COOKIE = '__Host-x-pos';
export const POSITION_HEADER = 'x-ultimate-position';
/** How long a write's position is carried: past it, a replica is assumed to have caught up. */
export const POSITION_STICKY_MS = 30_000;

/**
 * The position this request carries, parsed — the header an API client echoes, else the cookie a
 * browser does. Never the raw value: a forged one costs the sender a primary read, nothing more.
 */
export function carriedPosition(request: UltimateRequest): bigint | undefined {
  return (
    parsePosition(request.header(POSITION_HEADER)) ?? parsePosition(request.cookie(POSITION_COOKIE))
  );
}

/**
 * Stamps the position on the request's response-header bag, which the `response` stage lays onto
 * whatever Response the handler built — a `Response.redirect`, the write-then-redirect this exists
 * for, included. The cookie through `setCookie`, so its attributes are core's one serializer's.
 */
function stamp(ctx: RequestContext, position: bigint, stickyMs: number): void {
  const text = formatPosition(position);
  ctx.headers.set(POSITION_HEADER, text);
  setCookie(POSITION_COOKIE, text, { maxAge: Math.ceil(stickyMs / 1000) });
}

/**
 * Opens the scope with the carried position, runs the request, and — only when it wrote — reads the
 * primary's position ONCE after every transaction in it committed. Inside the scope, so the read
 * itself is the primary's: a scope that wrote routes nothing to the replica.
 */
export function positionStage(stickyMs: number = POSITION_STICKY_MS): Middleware {
  return (request, ctx, next) =>
    withReplicaReads(
      async (scope) => {
        const response = await next(request, ctx);
        if (!scope.wrote) return response;
        const position = await primaryPosition(db()).catch((error: unknown) => {
          // The write committed and the answer is ready: a lost position costs the NEXT request a
          // possibly stale replica read within the sticky window, never this request its answer.
          logger.warn('db.replica_position_unread', { error: renderThrowable(error) });
          return undefined;
        });
        if (position !== undefined) stamp(ctx, position, stickyMs);
        return response;
      },
      { minPosition: carriedPosition(request) },
    );
}
