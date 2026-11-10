// `reindex()`: rebuild a `SearchIndex` from the table, as a `backfill()` — so a FACTORY over a
// factory over `job()`, never a ninth primitive. Run after swapping the built-in Postgres index for
// Meilisearch or Typesense, or after the index lost data or missed deletes: every row through
// entity's ONE document builder (`searchDocumentOf`), then a sweep of what the table lost.

import type { Ctx, Environment } from '@ultimat3/core';
import { assert, finiteCount } from '@ultimat3/core';
import type { EntityCore, ReadBuilder, SearchIndex, SearchListEntry } from '@ultimat3/entity';
import {
  MAX_PAGE_SIZE,
  searchDocumentOf,
  searchIndex,
  searchVersionColumn,
} from '@ultimat3/entity';
import type { BackfillInput, BackfillPage } from './backfill';
import { backfill, DEFAULT_BACKFILL_BATCH } from './backfill';
import type { DurationInput } from './clock';
import type { JobHandle } from './job';
import { sweepListed } from './reindex-sweep';
import type { RetryPolicy } from './retry';
import type { JobTenant } from './tenant';
import { NO_JOB_TENANT } from './tenant';

export interface ReindexDefinition<Row> {
  /** REQUIRED: the backfill's durable key — its ledger row and queue key carry it. */
  readonly name: string;
  /** The entity whose `.searchable()` columns are indexed. */
  readonly entity: EntityCore<Row>;
  /**
   * The rows to index — the WHOLE table: `() => db.posts`. Read per page. The sweep removes every
   * document whose row this does not read, so a narrowed source empties the index of the rest.
   */
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

/** One item of the pass: a source row to index, or an index entry the sweep checks. */
type ReindexItem<Row> = { readonly row: Row } | { readonly entry: SearchListEntry };

const ROWS = 'rows:';
const SWEEP = 'sweep:';

/** The phase a checkpointed cursor names, and the position inside it (`null`: from the top). */
const phaseOf = (
  cursor: string | null,
): { readonly sweep: boolean; readonly at: string | null } => {
  if (cursor?.startsWith(SWEEP) === true) {
    const at = cursor.slice(SWEEP.length);
    return { sweep: true, at: at === '' ? null : at };
  }
  const at = cursor?.slice(ROWS.length) ?? '';
  return { sweep: false, at: at === '' ? null : at };
};

/** One batch of the source at `at`, and where the next starts — the sweep, once it is exhausted. */
async function rowsPage<Row>(
  source: ReindexDefinition<Row>['source'],
  ctx: Ctx,
  at: string | null,
  size: number,
): Promise<BackfillPage<ReindexItem<Row>>> {
  const batches = source({ ctx }).after(at).inBatches(size);
  try {
    const first = await batches[Symbol.asyncIterator]().next();
    const rows = first.done === true ? [] : first.value;
    const next = first.done === true ? null : batches.cursor;
    return { rows: rows.map((row) => ({ row })), next: next === null ? SWEEP : `${ROWS}${next}` };
  } finally {
    await batches.close();
  }
}

/**
 * Two phases, one `backfill()`, one durable step per page. First every source row's document is
 * written — at least once per batch: each carries its row's `onUpdateNow()` version and the index
 * keeps only newer, so a replayed batch is a no-op and a batch that read a row before a write (or
 * before its delete's tombstone) cannot put the old text back. Then the SWEEP: every document the
 * index `list`s whose row `source` no longer reads is removed (`reindex-sweep.ts`) — so `source` is
 * the whole table, and after a pass the index holds what it reads and nothing else.
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
  // Screened here, before `backfill()` sees it: `size` also bounds the sweep's `list` page.
  const size = finiteCount(
    `reindex "${definition.name}"`,
    'batch',
    definition.batch ?? DEFAULT_BACKFILL_BATCH,
    1,
  );
  const everyTenant = definition.tenant === NO_JOB_TENANT;
  return backfill<ReindexItem<Row>>({
    name: definition.name,
    tenant: definition.tenant,
    pages: async ({ ctx, cursor }) => {
      const phase = phaseOf(cursor);
      if (!phase.sweep) return rowsPage(definition.source, ctx, phase.at, size);
      // A declared tenant sweeps its own documents; `'none'` every tenant's, under the pass's
      // cross-tenant scope (`backfill-scope.ts`).
      const page = await index().list({
        entity: entity.$name,
        ...(everyTenant ? {} : { tenant: ctx.actor?.orgId ?? null }),
        after: phase.at,
        limit: Math.min(size, MAX_PAGE_SIZE),
      });
      return {
        rows: page.entries.map((entry) => ({ entry })),
        next: page.next === null ? null : `${SWEEP}${page.next}`,
      };
    },
    handle: async ({ rows, ctx }) => {
      const documents = rows.flatMap((item) =>
        'row' in item ? [searchDocumentOf(entity, item.row)] : [],
      );
      if (documents.length > 0) await index().index(documents);
      const entries = rows.flatMap((item) => ('entry' in item ? [item.entry] : []));
      await sweepListed({ entity, source: definition.source, ctx, index: index(), entries });
    },
    ...(definition.batch === undefined ? {} : { batch: definition.batch }),
    ...(definition.rate === undefined ? {} : { rate: definition.rate }),
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.retry === undefined ? {} : { retry: definition.retry }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    ...(definition.environments === undefined ? {} : { environments: definition.environments }),
  });
}
