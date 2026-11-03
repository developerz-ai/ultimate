// Single responsibility: `lock` and `lockKey` on the typed handle. The refusal lives here because
// the repository contract lets a hand-written driver omit both, so only this layer can say so.

import { lockUnsupported } from './lock-unsupported';
import type { Repo, RepoOptions, Tx } from './repo';
import type { IdOf } from './types';

export interface TableLocks<Row> {
  /**
   * `db.posts.lock(id, async (post, tx) => db.posts.update(id, next(post), { tx }))`: the row, locked
   * for `fn`, so a read-modify-write loses no update. `fn`'s answer is the answer; a throw rolls back.
   * Absent or another tenant's is `X_NOT_FOUND`. Nested in `withTransaction` the lock lasts to the
   * root COMMIT. No wait option: the bound is the role's `statement_timeout`, and a deadlock is
   * `X_DB_SERIALIZATION_FAILURE`.
   */
  lock<R>(
    id: IdOf<Row>,
    fn: (row: Row, tx: Tx) => Promise<R> | R,
    options?: RepoOptions,
  ): Promise<R>;
  /**
   * `fn` alone among callers of `key` in this table and this tenant, for work no one row names. Org
   * A's key never blocks org B. On a tenant-scoped entity with no actor it is `X_TENANCY_UNSCOPED`.
   */
  lockKey<R>(key: string, fn: (tx: Tx) => Promise<R> | R, options?: RepoOptions): Promise<R>;
}

/** Called as methods and refused in an `async` body, so a class-shaped driver keeps its `this`. */
export const tableLocks = <Row>(
  entity: { readonly $name: string },
  repo: Repo<Row>,
): TableLocks<Row> => ({
  lock: async (id, fn, options) => {
    if (repo.lock === undefined) throw lockUnsupported(entity.$name, 'lock');
    return repo.lock(id, fn, options);
  },
  lockKey: async (key, fn, options) => {
    if (repo.lockKey === undefined) throw lockUnsupported(entity.$name, 'lockKey');
    return repo.lockKey(key, fn, options);
  },
});
