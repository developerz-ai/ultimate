// Committed row changes, as the framework's own repositories saw them, emitted on the bus as
// `entity.row` / `entity.bulk`. One emitter, above the driver, so it reports the same changes
// whether rows live in memory or in Postgres.
//
// It exists because a change feed needs a source and only one of the two has one. Production
// decodes the write-ahead log (`@ultimat3/realtime`'s `postgresChangeFeed()`); PGlite has no
// walsender and the memory driver has no log at all, so `memoryChangeFeed()` — which that package
// calls "the blessed development and test feed" — had nothing upstream of it. That is what left
// `@ultimat3/testing`'s `subscribe` fixture with no driver: a live query with no changes flowing
// into it is a snapshot, and a snapshot is not what those tests assert.
//
// NOT a second change-feed path. This reports what a repository wrote; the replicator reports what
// the server committed, including writes this process never made. A node with a replicator uses
// the replicator — `@ultimat3/realtime`'s `selectChangeFeed` still decides, and this is never in
// that decision.

import { currentWriteOrigin, type EntityRowOp, instrument, subscribed } from '@ultimat3/core';
import { expectedQueryLoop } from '@ultimat3/db';
import { copyColumns } from './copy-plan';
import type { EntityCore } from './entity';
import { MAX_PAGE_SIZE } from './plan';
import { readRecorder } from './read-capture';
import type { Repo, RepoOptions, UpsertArgs } from './repo';
import { sealedFields } from './sealed';
import { searchMirroredRepo } from './search-mirrored-repo';
import type { IdOf, RowPatch } from './types';
import { afterCommit } from './write-commit';

/**
 * A committed row change is `entity.row` on the bus (`EntityRowEvent`, core's shape): `before` and
 * `after` are whole rows, exactly as logical replication reports them with `REPLICA IDENTITY FULL`
 * — a subscriber diffs them itself rather than trusting a patch it did not compile. `write` is
 * `currentWriteOrigin()` at the moment the repository wrote; the WAL decoder reads the same fact.
 *
 * `deleteWhere` and `updateWhere` name a filter, not a row, and reading the matching rows first
 * would turn one statement into two — so they are `entity.bulk` (`EntityBulkEvent`), a count a
 * subscriber re-reads on rather than silence, which is the one answer that diverges silently.
 */
const ROW = 'entity.row';
const BULK = 'entity.bulk';

/**
 * The reads a change needs and a plain write does not. `before` costs one `findById` per update and
 * per delete — paid ONLY while `entity.row` has a subscriber, which is why the guard is the first line
 * of every method below rather than a flag read once at wrap time. With none this wrapper is one map
 * read and a delegation, on a path that already awaits a database.
 */
const idOf = (value: unknown): string | undefined => {
  const id = (value as { readonly id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : undefined;
};

const asRecord = (row: unknown): Readonly<Record<string, unknown>> | null =>
  typeof row === 'object' && row !== null ? (row as Readonly<Record<string, unknown>>) : null;

/**
 * Whether `findById(row.id)` is the right lookup for this entity at all. It is exactly when the
 * primary key IS `id` — on a composite key `findById` cannot name a row, and an `id` column that is
 * not the key would read a DIFFERENT row than the write touched. Answering `null` there beats
 * answering confidently with somebody else's row.
 */
const readsById = (entity: EntityCore<unknown>): boolean =>
  entity.$primaryKey.length === 1 && entity.$primaryKey[0] === 'id';

/**
 * The `before` row, or `null` when this process could not read one.
 *
 * `null` is not a lie: it is exactly what logical replication reports for a table whose
 * `REPLICA IDENTITY` is not `FULL`. A consumer that diffs before against after then produces a
 * patch carrying every column instead of only the changed ones — wider, never wrong.
 *
 * The `catch` is a FLOOR, not a case: no write in this repo is known to succeed while its own
 * `findById` refuses, because every guard a read applies — tenancy, soft delete — the write applies
 * too. It stays because the cost of being wrong is asymmetric: a subscriber is a diagnostic, and a
 * diagnostic that turns a working write into a failing one is worse than the gap it was closing.
 */
const beforeOf = async <Row>(
  entity: EntityCore<Row>,
  repo: Repo<Row>,
  id: IdOf<Row>,
): Promise<Row | null> => {
  if (!readsById(entity as EntityCore<unknown>)) return null;
  try {
    // Expected, with the reason on the statement: this is ONE read for ONE point write, and a
    // request that updates fifty rows one at a time is already fifty `update` statements — the
    // caller's loop, reported on the caller's writes. Without the scope the same loop was reported
    // twice, the second verdict naming a `findById` no app code issued.
    return await expectedQueryLoop(
      'the entity.row event reads the row a point write is about to change — one read per write',
      () => repo.findById(id),
    );
  } catch {
    return null;
  }
};

/**
 * The `before` rows of a batch, read as ONE statement per `MAX_PAGE_SIZE` ids rather than one per
 * row. Measured on one adopter's app, 2026-09-06: an `upsertAll` of five pull requests logged
 * `X_N_PLUS_ONE_QUERY: pull_requests.findById ran 5 times in one request` — the framework's own
 * feed tripping the framework's own detector, exactly as the job step-write did before #415. A
 * `findById` per row is not even coalesced into one statement, because each one is awaited
 * before the next is issued and the coalescer's window is a microtask.
 *
 * `findMany` with `in` reads through the same plan a `findById` does — same tenant scope, same
 * soft-delete filter — so a row this cannot see is a row `findById` could not see either. The
 * page bound is the one every read has: past it the batch is several statements, never a refusal.
 *
 * The `catch` is `beforeOf`'s, for its reason: a diagnostic must not turn a working write into a
 * failing one. On failure every row of the batch reports as an insert with no `before`, which is
 * what `null` already means.
 */
const beforeAllOf = async <Row>(
  entity: EntityCore<Row>,
  repo: Repo<Row>,
  ids: readonly string[],
): Promise<ReadonlyMap<string, Row>> => {
  const before = new Map<string, Row>();
  if (ids.length === 0 || !readsById(entity as EntityCore<unknown>)) return before;
  try {
    for (let at = 0; at < ids.length; at += MAX_PAGE_SIZE) {
      const chunk = ids.slice(at, at + MAX_PAGE_SIZE);
      const page = await repo.findMany({
        where: [{ column: 'id', op: 'in', value: chunk }],
        limit: chunk.length,
      });
      for (const row of page.rows) {
        const id = idOf(row);
        if (id !== undefined) before.set(id, row);
      }
    }
  } catch {
    before.clear();
  }
  return before;
};

/**
 * Wrap one repository so its writes are reported. Applied by `database()` to every table it builds,
 * so an app opts in by subscribing to `entity.row` and never by choosing a different repository — the
 * rows under test are the rows the app reads, which is the whole reason `defaultDriver()` is
 * exported at all.
 */
export function observedRepo<Row>(entity: EntityCore<Row>, driven: Repo<Row>): Repo<Row> {
  const name = entity.$name;
  // Beneath the observer, so a searchable entity's writes reach an external index whether or not
  // anything hears `entity.row` (`search-mirrored-repo.ts`).
  const repo = searchMirroredRepo(entity, driven);
  const sealed = sealedFields(entity).map((field) => field.property);

  /**
   * A reported row WITHOUT its sealed properties. This wrapper sits above the sealing seam, so the
   * rows it holds carry plaintext — and a change is what a live query delivers to a subscriber. A
   * sealed column leaves the server through no path, so it is not on a change either.
   */
  const reported = (row: unknown): Readonly<Record<string, unknown>> | null => {
    const record = asRecord(row);
    if (record === null || sealed.length === 0) return record;
    return Object.fromEntries(
      Object.entries(record).filter(([property]) => !sealed.includes(property)),
    );
  };

  /**
   * Reported at COMMIT (`write-commit.ts`): a change reported before COMMIT put a row in a live
   * query that a rollback then erased (plan 101, 06 m). The write origin is read NOW: it is the
   * request's, and the commit callback may run outside that request's scope.
   */
  const emit = (
    op: EntityRowOp,
    before: unknown,
    after: unknown,
    options: RepoOptions | undefined,
  ): void => {
    if (!subscribed(ROW)) return;
    const write = currentWriteOrigin();
    const change = {
      entity: name,
      op,
      before: reported(before),
      after: reported(after),
      ...(write === undefined ? {} : { write }),
    };
    afterCommit(options, () => instrument(ROW, change));
  };

  const bulk = (op: 'delete' | 'update', rows: number, options: RepoOptions | undefined): void => {
    if (rows > 0 && subscribed(BULK)) {
      afterCommit(options, () => instrument(BULK, { entity: name, op, rows }));
    }
  };

  // Spread first, exactly as `examples/dummy`'s own capturing driver does: a repository may carry
  // members `Repo` does not name — `memoryRepo`'s `reset()` is one — and a wrapper that listed only
  // the interface would silently drop them.
  // The read half of failure capture (`read-capture.ts`): one check when no captured call is open.
  const read = readRecorder(name, sealed);

  const observed: Repo<Row> = {
    ...repo,

    findById: async (id, options) => {
      const row = await repo.findById(id, options);
      if (row !== null) read([row]);
      return row;
    },

    findMany: async (args) => {
      const page = await repo.findMany(args);
      read(page.rows);
      return page;
    },

    insert: async (values: Row, options?: RepoOptions): Promise<Row> => {
      const stored = await repo.insert(values, options);
      emit('insert', null, stored, options);
      return stored;
    },

    insertAll: async (rows: readonly Row[], options?: RepoOptions): Promise<readonly Row[]> => {
      const stored = await repo.insertAll(rows, options);
      for (const row of stored) emit('insert', null, row, options);
      return stored;
    },

    /**
     * `before` is read for the rows that carry an id — as one statement, `beforeAllOf` — because a
     * collision is what separates an insert from an update here and nothing else in the result
     * says which happened. Under `onMatch: 'nothing'` a row already stored is absent from the
     * result — so it wrote nothing, and reporting a change for it would be reporting a write that
     * did not occur.
     */
    upsertAll: async (rows: readonly Row[], args: UpsertArgs<Row>): Promise<readonly Row[]> => {
      if (!subscribed(ROW)) return await repo.upsertAll(rows, args);
      const ids = [...new Set(rows.flatMap((row) => idOf(row) ?? []))];
      const before = await beforeAllOf(entity, repo, ids);
      const stored = await repo.upsertAll(rows, args);
      for (const row of stored) {
        const id = idOf(row);
        const previous = id === undefined ? null : (before.get(id) ?? null);
        emit(previous === null ? 'insert' : 'update', previous, row, args);
      }
      return stored;
    },

    update: async (id, patch: RowPatch<Row>, options?: RepoOptions): Promise<Row> => {
      if (!subscribed(ROW)) return await repo.update(id, patch, options);
      const before = await beforeOf(entity, repo, id);
      const after = await repo.update(id, patch, options);
      emit('update', before, after, options);
      return after;
    },

    delete: async (id, options?: RepoOptions): Promise<void> => {
      if (!subscribed(ROW)) return await repo.delete(id, options);
      const before = await beforeOf(entity, repo, id);
      await repo.delete(id, options);
      emit('delete', before, null, options);
    },

    deleteWhere: async (filter: RowPatch<Row>, options?: RepoOptions): Promise<number> => {
      const rows = await repo.deleteWhere(filter, options);
      bulk('delete', rows, options);
      return rows;
    },

    updateWhere: async (
      filter: RowPatch<Row>,
      patch: RowPatch<Row>,
      options?: RepoOptions,
    ): Promise<number> => {
      const rows = await repo.updateWhere(filter, patch, options);
      bulk('update', rows, options);
      return rows;
    },
  };

  /**
   * The count-only writes report as their counterparts do. An insert's `entity.row` carries the
   * stored row, so with a subscriber the call runs as its returning form and answers the length;
   * with none it is the count path untouched. `updateMany` is `entity.bulk`, as `updateWhere` is.
   * Each is present only where the repository has it, so the typed handle's fallback still sees
   * an absence.
   */
  const { insertAllCount, upsertAllCount, copyAll, updateMany } = repo;
  if (insertAllCount !== undefined) {
    observed.insertAllCount = async (rows, options) =>
      subscribed(ROW)
        ? (await observed.insertAll(rows, options)).length
        : insertAllCount.call(repo, rows, options);
  }
  if (upsertAllCount !== undefined) {
    observed.upsertAllCount = async (rows, args) =>
      subscribed(ROW)
        ? (await observed.upsertAll(rows, args)).length
        : upsertAllCount.call(repo, rows, args);
  }
  if (copyAll !== undefined) {
    observed.copyAll = async (rows, options) => {
      if (!subscribed(ROW)) return copyAll.call(repo, rows, options);
      // COPY's own refusal first, so a load is refused alike with or without a subscriber.
      copyColumns(entity, rows as readonly RowPatch<Row>[]);
      return (await observed.insertAll(rows, options)).length;
    };
  }
  if (updateMany !== undefined) {
    observed.updateMany = async (rows, options) => {
      const written = await updateMany.call(repo, rows, options);
      bulk('update', written, options);
      return written;
    };
  }
  return observed;
}
