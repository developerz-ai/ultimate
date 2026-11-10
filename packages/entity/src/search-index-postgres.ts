// `postgresSearchIndex()`: the built-in `SearchIndex` — `.searchable()`'s generated `tsvector`,
// behind the port. Postgres keeps the vector itself on every write (`generated always as … stored`),
// so `index`/`remove` only check the entity and send nothing; `query` is the repository's own
// `matches` read, so tenancy, the actor check and soft delete are the ones `.search()` already has.

import type { DbClient } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import { searchUndeclared } from './feature-errors';
import { postgresRepo } from './pg-driver';
import { getEntity } from './registry';
import { rowKey } from './row-key';
import { SEARCH_PROPERTY } from './search';
import type { SearchHit, SearchIndex, SearchScope } from './search-index';
import { searchLimitOf } from './search-index';
import type { Predicate } from './tenancy';

export interface PostgresSearchIndexOptions {
  /** Pin a client; left out, the ambient pool (or the open transaction) per statement. */
  readonly client?: DbClient;
}

/** The registered entity a scope names, with a search vector — refused otherwise. */
const searchableEntity = (name: string): EntityCore<unknown> => {
  const core = getEntity(name)?.core;
  if (core === undefined || core.$search === null) throw searchUndeclared(name);
  return core;
};

/** The tenant predicate a scope adds; a tenant named on an untenanted entity is refused. */
const tenantPredicate = (core: EntityCore<unknown>, scope: SearchScope): readonly Predicate[] => {
  const column = core.$tenantColumn;
  if (column === null) {
    if (scope.tenant === null) return [];
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `search of ${core.$name} named a tenant, but ${core.$name} has no tenant column — the tenant would scope nothing`,
      fix: 'searchIndex().query({ entity, tenant: null, term }) — an untenanted entity is searched whole',
    });
  }
  // `null` on a tenanted entity adds no predicate: the repository then takes the acting actor's
  // tenant, or refuses `X_TENANCY_UNSCOPED` — the rule every other read of it already follows.
  return scope.tenant === null ? [] : [{ column, op: 'eq', value: scope.tenant }];
};

/**
 * `index` and `remove` send nothing, so the version contract holds by construction: the table IS
 * the newest state, and a stale document never reaches it.
 *
 * The indexes whose match is the statement's own `matches` predicate — a chain's `.search()` then
 * sends today's single statement (`pg-sql.ts`'s `searchSql`), never a round trip for ids. Only
 * this file adds to it: an app's index is always asked through the port.
 */
const inStatement = new WeakSet<SearchIndex>();

export const answersInStatement = (index: SearchIndex): boolean => inStatement.has(index);

export const postgresSearchIndex = (options: PostgresSearchIndexOptions = {}): SearchIndex => {
  const repoOf = (core: EntityCore<unknown>) =>
    postgresRepo(core, options.client === undefined ? {} : { client: options.client });
  const index: SearchIndex = {
    name: 'postgres',
    index: async (documents) => {
      for (const document of documents)
        tenantPredicate(searchableEntity(document.entity), document);
    },
    remove: async (scope) => {
      tenantPredicate(searchableEntity(scope.entity), scope);
    },
    query: async (query): Promise<readonly SearchHit[]> => {
      const limit = searchLimitOf(query);
      const core = searchableEntity(query.entity);
      const where: readonly Predicate[] = [
        ...tenantPredicate(core, query),
        { column: SEARCH_PROPERTY, op: 'matches', value: query.term },
      ];
      // Primary-key order, as `.search()` with no `orderBy` answers: a rank is not a sort key the
      // plan can seek on, so the built-in index returns matches, not a relevance order.
      const page = await repoOf(core).findMany({ where, limit });
      return page.rows.map((row) => ({ id: rowKey(core, row) }));
    },
  };
  inStatement.add(index);
  return index;
};
