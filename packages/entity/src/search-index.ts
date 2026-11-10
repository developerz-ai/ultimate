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

/** How a batch of documents reached `index`. */
export interface SearchIndexOptions {
  /**
   * `true` from the write path: each document is a row a COMMITTED write left, so it replaces a
   * TOMBSTONE whatever the two versions say — a key deleted and written again is live, even inside
   * one millisecond. Against a held document it still keeps only newer. Unset (`reindex`'s reads):
   * a tombstone at the document's version or newer refuses it, so a stale read never brings a
   * deleted row back.
   */
  readonly committed?: boolean;
}

/**
 * One page of what an index holds for an entity — what `reindex`'s sweep compares with the table.
 * `tenant` absent is EVERY tenant's documents: a maintenance read, under the same tenancy rule a
 * `query` with `tenant: null` follows (the built-in index needs `crossTenant` for it).
 */
export interface SearchListQuery {
  readonly entity: string;
  readonly tenant?: string | null;
  /** The previous page's `next`; `null` for the first page. Opaque to the caller. */
  readonly after: string | null;
  /** At most this many entries, from 1 to `MAX_PAGE_SIZE`. */
  readonly limit: number;
}

/** A document the index holds — never a tombstone. */
export interface SearchListEntry {
  readonly tenant: string | null;
  readonly id: string;
  /** The version it holds for the id: a sweep's removal is tombstoned just above it. */
  readonly version: number;
}

export interface SearchListPage {
  readonly entries: readonly SearchListEntry[];
  /** Where the next page starts; `null` once there is none. */
  readonly next: string | null;
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
 * holds for that id — a document, or the TOMBSTONE a `remove` leaves, unless the write path sent it
 * (`committed`), which replaces a tombstone. A version equal to the one held is a replay.
 */
export interface SearchIndex {
  readonly name: string;
  /**
   * Insert or replace each document under its `(entity, tenant, id)`, when it is newer than the
   * document held — or, `committed`, whatever tombstone is held (`SearchIndexOptions`).
   */
  index(documents: readonly SearchDocument[], options?: SearchIndexOptions): Promise<void>;
  /**
   * Drop these ids of `scope` and leave a tombstone at `version` (the delete's instant, epoch ms),
   * so a document no newer than the delete is refused. Another tenant's id is left where it is.
   */
  remove(scope: SearchScope, ids: readonly string[], version: number): Promise<void>;
  query(query: SearchQuery): Promise<readonly SearchHit[]>;
  /**
   * Every live document of an entity, paged in an order the index keeps stable across calls: each
   * id once, none removed. `reindex` sweeps with it, removing what the table no longer holds.
   */
  list(query: SearchListQuery): Promise<SearchListPage>;
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

/** A `list` page size, checked once for every index. */
export const searchListLimitOf = (query: SearchListQuery): number => {
  const { limit } = query;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `list of ${query.entity}'s search documents: limit must be a whole number from 1 to ${MAX_PAGE_SIZE}, got ${String(limit)}`,
      fix: `searchIndex().list({ entity, after: null, limit: ${DEFAULT_SEARCH_LIMIT} })`,
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
