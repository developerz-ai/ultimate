// `reindex()`: rebuild a `SearchIndex` from the table, as a `backfill()` — so a FACTORY over a
// factory over `job()`, never a ninth primitive. It is what an app runs after swapping the built-in
// Postgres index for Meilisearch or Typesense, or after the index lost data: one batch per durable
// step, the cursor checkpointed, each row through entity's ONE document builder (`searchDocumentOf`).

import type { Ctx, Environment } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type { EntityCore, ReadBuilder, SearchIndex } from '@ultimat3/entity';
import { searchDocumentOf, searchIndex, searchVersionColumn } from '@ultimat3/entity';
import type { BackfillInput } from './backfill';
import { backfill } from './backfill';
import type { DurationInput } from './clock';
import type { JobHandle } from './job';
import type { RetryPolicy } from './retry';
import type { JobTenant } from './tenant';

export interface ReindexDefinition<Row> {
  /** REQUIRED: the backfill's durable key — its ledger row and queue key carry it. */
  readonly name: string;
  /** The entity whose `.searchable()` columns are indexed. */
  readonly entity: EntityCore<Row>;
  /** The rows to index — usually the whole table: `() => db.posts`. Read once per attempt. */
  source(args: { readonly ctx: Ctx }): ReadBuilder<Row>;
  /** As on `backfill()`: `'none'` for a sweep of every tenant, each document keeping its own. */
  readonly tenant: JobTenant<BackfillInput>;
  /** Default: the installed index (`runtime.ts`'s `searchIndex`, else Postgres' built-in). */
  readonly index?: () => SearchIndex;
  readonly batch?: number;
  readonly rate?: number;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: DurationInput;
  readonly environments?: readonly Environment[];
}

/** True when at least one column of `entity` is declared `.searchable()`. */
const isSearchable = (entity: EntityCore<unknown>): boolean =>
  Object.values(entity.$columns).some((column) => column.$meta.searchable !== undefined);

/**
 * A full pass that writes every row's document to the index. At least once per batch, like every
 * backfill: each document carries its row's `onUpdateNow()` version and the index keeps only
 * newer, so a replayed batch is a no-op and a batch that read a row before a write (or before its
 * delete's tombstone) cannot put the old text back. Rows deleted since the last pass are NOT
 * removed — that is the write path's `remove(scope, ids, deletedAt)`, not a sweep's.
 */
export function reindex<Row>(definition: ReindexDefinition<Row>): JobHandle<BackfillInput> {
  const { entity } = definition;
  assert(
    isSearchable(entity as EntityCore<unknown>),
    `reindex "${definition.name}" names entity ${entity.$name}, which has no .searchable() column — there is nothing to index`,
    `title: text().searchable()   # in entity('${entity.$name}'): mark the columns a search reads, or drop reindex "${definition.name}"`,
  );
  // At declaration, not at the first batch: a document without a version is one an index cannot
  // order against a write, so the entity must declare its `onUpdateNow()` column first.
  searchVersionColumn(entity as EntityCore<unknown>);
  const index = definition.index ?? searchIndex;
  return backfill<Row>({
    name: definition.name,
    tenant: definition.tenant,
    source: (args) => definition.source(args),
    handle: ({ rows }) => index().index(rows.map((row) => searchDocumentOf(entity, row))),
    ...(definition.batch === undefined ? {} : { batch: definition.batch }),
    ...(definition.rate === undefined ? {} : { rate: definition.rate }),
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.retry === undefined ? {} : { retry: definition.retry }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    ...(definition.environments === undefined ? {} : { environments: definition.environments }),
  });
}
