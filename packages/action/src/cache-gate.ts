/**
 * The post-commit cache bust — the only file in this package that calls `invalidateTags`.
 * Post-COMMIT, not post-handler: inside a transaction it waits for the root commit. A fan-out that
 * refuses degrades to one logged failure instead of a failed action — the stale entries expire by
 * TTL, and the caller keeps the write it already made.
 */

import type { CacheTag, InvalidationReport } from '@ultimat3/cache';
import { invalidateTags } from '@ultimat3/cache';
import { logger } from '@ultimat3/core';
import { type CommitScope, openCommitScope } from './tx-scope';

/**
 * Fan `tags` out and never throw. `undefined` back means nothing was cleared BY THIS CALL: the
 * fan-out refused — an undeclared tag (`X_CACHE_TAG_UNKNOWN`) is the one an app hits — or it was
 * deferred. One dead tier is not that case: `invalidateTags` absorbs those into `report.errors`.
 *
 * Inside a transaction (`scope`, the ambient one unless a caller passes its own) the handler's rows
 * are not durable when it returns. Busting there let a concurrent read refill the cache with the
 * pre-commit rows, which then stayed for the TTL — and a rollback busted for a write nobody made.
 * So the bust is handed to the ROOT commit, as `@ultimat3/entity`'s row observer hands its report:
 * `onCommit` never fires for a transaction that rolled back or whose COMMIT was lost.
 */
export async function bustAfterCommit(
  action: string,
  tags: readonly CacheTag[],
  scope: CommitScope | undefined = openCommitScope(),
): Promise<InvalidationReport | undefined> {
  if (scope === undefined) return bust(action, tags);
  // Not awaited, and it cannot be: a commit effect is synchronous and runs after the transaction
  // is durable. `bust` never rejects, so there is no rejection for the missing await to lose.
  scope.onCommit(() => void bust(action, tags));
  return undefined;
}

async function bust(
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
