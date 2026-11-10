// The `searchIndex` port: where a full-text search over an entity's `.searchable()` columns is
// answered. Postgres' generated `tsvector` is the built-in one (`search-index-postgres.ts`); an app
// writes Meilisearch or Typesense against this interface. Tenant-scoped on every call: a document
// is indexed under its tenant, and a query or a removal names the tenant it may reach.

import type { EntityCore } from './entity';
import { EntityError } from './errors';
import { MAX_PAGE_SIZE } from './plan';
import { rowKey } from './row-key';
import { searchVersionOf } from './search-index-version';

/** What a search answers: the entity's name and the rows' tenant, never one without the other. */
export interface SearchScope {
  /** The entity NAME (`entity('<name>', …)`), not its table. */
  readonly entity: string;
  /** The tenant column's value; `null` for an untenanted entity, and only for one. */
  readonly tenant: string | null;
}

/** One row as the index sees it: its key and the text of every searchable column it holds. */
export interface SearchDocument extends SearchScope {
  /** `rowKey(entity, row)` — the id a hit hands back to `findById`. */
  readonly id: string;
  /**
   * The row's `onUpdateNow()` instant, epoch ms (`search-index-version.ts`). An index keeps the
   * NEWEST version per id and refuses an older one — a `reindex` batch read before a write.
   */
  readonly version: number;
  /** Searchable property → its text. A NULL column is absent, never `''`. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface SearchQuery extends SearchScope {
  /**
   * What a search box sent. Every word must match (case-insensitively); punctuation is text and
   * never an error; a term with no word in it answers no hits.
   */
  readonly term: string;
  /** At most this many hits. Default `DEFAULT_SEARCH_LIMIT`, at most `MAX_PAGE_SIZE`. */
  readonly limit?: number;
}

/** A match: the row's id, best first in the index's own relevance order. */
export interface SearchHit {
  readonly id: string;
}

/**
 * The port. `index` and `remove` take batches because `reindex` (a `backfill()` job) walks a table
 * page by page. Every method is tenant-scoped: an index that answers tenant A a document indexed
 * under tenant B is broken, and `searchIndexConformance` says so.
 *
 * Keep only newer: a document is applied only when its `version` is newer than what the index
 * holds for that id — a document, or the TOMBSTONE a `remove` leaves. A version equal to the one
 * held is a replay and changes nothing.
 */
export interface SearchIndex {
  readonly name: string;
  /** Insert or replace each document under its `(entity, tenant, id)`, when it is newer. */
  index(documents: readonly SearchDocument[]): Promise<void>;
  /**
   * Drop these ids of `scope` and leave a tombstone at `version` (the delete's instant, epoch ms),
   * so a document no newer than the delete is refused. Another tenant's id is left where it is.
   */
  remove(scope: SearchScope, ids: readonly string[], version: number): Promise<void>;
  query(query: SearchQuery): Promise<readonly SearchHit[]>;
}

export const DEFAULT_SEARCH_LIMIT = 20;

/** The limit a query asked for, checked once for every index. */
export const searchLimitOf = (query: SearchQuery): number => {
  const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `search of ${query.entity}: limit must be a whole number from 1 to ${MAX_PAGE_SIZE}, got ${String(limit)}`,
      fix: `searchIndex().query({ entity, tenant, term, limit: ${DEFAULT_SEARCH_LIMIT} })`,
    });
  }
  return limit;
};

/**
 * The document a row of `entity` is indexed as — the ONE builder, so a write hook and `reindex`
 * cannot index the same row two ways. Only `.searchable()` columns travel; nothing else of the row
 * (a sealed column is never searchable, `sealed-column.ts`) leaves for an external index. Its
 * version is the row's `onUpdateNow()` instant; an entity declaring none is refused.
 */
export const searchDocumentOf = <Row>(entity: EntityCore<Row>, row: Row): SearchDocument => {
  const record = row as Readonly<Record<string, unknown>>;
  const fields: Record<string, string> = {};
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (column.$meta.searchable === undefined) continue;
    const value = record[property];
    if (typeof value === 'string') fields[property] = value;
  }
  const tenantColumn = entity.$tenantColumn;
  const tenant = tenantColumn === null ? null : record[tenantColumn];
  return {
    entity: entity.$name,
    tenant: typeof tenant === 'string' ? tenant : null,
    id: rowKey(entity, row),
    version: searchVersionOf(entity, row),
    fields,
  };
};
