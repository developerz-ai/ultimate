/**
 * The relations a live read is patched from: the one thing about a query that cannot be derived,
 * and the two assertions that keep the declaration honest — a stale name is a declaration its
 * author reads as true. Since #518 `x db gen` grants these relations no `REPLICA IDENTITY FULL`:
 * every entity is keyed, and a keyed table is correct on DEFAULT (`x db gen` validates the names).
 */

import { QuerySubscribesDriftError, QuerySubscribesInvalidError } from './errors';

/**
 * Judged at `query()`, beside `assertCacheTtl` and for its reason: a declaration nothing can act on
 * is wrong for every subscriber of that read, so it fails on the line that wrote it.
 *
 * A read that is not live is refused rather than ignored. `subscribes:` has exactly one reader and
 * that reader only walks live queries, so an accepted one would be a declaration nothing verifies
 * and nothing emits — the shape of defect this field exists to close.
 */
export function assertSubscribes(
  subscribes: readonly string[] | undefined,
  live: boolean | undefined,
): void {
  if (subscribes === undefined) return;
  if (subscribes.length === 0) throw new QuerySubscribesInvalidError('empty');
  if (live !== true) throw new QuerySubscribesInvalidError('not-live');
}

/**
 * Judged at the first subscribe, because `shape.entity` is the first answer the framework has to
 * "which relation does this read actually name" — the string sits inside `sql:`, a callback no
 * static reader can invoke without valid input.
 *
 * Membership, never equality: a `QueryShape` names ONE relation while a read may join several, and
 * `@ultimat3/db` keeps only the declared names an entity's table matches. So a name the shape never
 * resolves to costs nothing, and the resolved one going MISSING is the whole failure.
 */
export function assertSubscribed(
  name: string,
  subscribes: readonly string[] | undefined,
  entity: string,
): void {
  if (subscribes === undefined) return;
  if (subscribes.includes(entity)) return;
  throw new QuerySubscribesDriftError(name, subscribes, entity);
}
