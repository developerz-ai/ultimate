/**
 * The post-commit cache bust — the only file in this package that calls `invalidateTags`.
 * The handler has already committed by the time it runs, so a fan-out that refuses degrades to
 * one logged failure instead of a failed action: the stale entries expire by TTL, and the caller
 * keeps the write it already made.
 */

import type { CacheTag, InvalidationReport } from '@ultimat3/cache';
import { invalidateTags } from '@ultimat3/cache';
import { logger } from '@ultimat3/core';

/**
 * Fan `tags` out and never throw. `undefined` back means the fan-out itself refused and nothing
 * was cleared — an undeclared tag (`X_CACHE_TAG_UNKNOWN`) is the one an app hits. One dead tier
 * is not that case: `invalidateTags` absorbs those into `report.errors` and still reports.
 */
export async function bustAfterCommit(
  action: string,
  tags: readonly CacheTag[],
): Promise<InvalidationReport | undefined> {
  try {
    return await invalidateTags(tags);
  } catch (error) {
    // Neither the tags nor `ctx.logger`. Reading a malformed `invalidates` entry back to render
    // it throws a second time, out of the branch whose whole job is not to — and the failure
    // names the offending tag while `action` names the one place `invalidates` is declared. Core's
    // logger already carries `requestId`/`traceId` from the ambient context; an HTTP `Ctx` is a
    // cast request context that carries no `logger` at all.
    logger.error('action.invalidate.failed', { action, error });
    return undefined;
  }
}
