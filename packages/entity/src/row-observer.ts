// Committed row changes, as the framework's own repositories saw them. One seam, above the driver,
// so it reports the same changes whether rows live in memory or in Postgres.
//
// It exists because a change feed needs a source and only one of the two has one. Production
// decodes the write-ahead log (`@ultimat3/realtime`'s `PgLogicalReplicationFeed`); PGlite has no
// walsender and the memory driver has no log at all, so `InMemoryChangeFeed` — which that package
// calls "the blessed development and test feed" — had nothing upstream of it. That is what left
// `@ultimat3/testing`'s `subscribe` fixture with no driver: a live query with no changes flowing
// into it is a snapshot, and a snapshot is not what those tests assert.
//
// NOT a second change-feed path. This reports what a repository wrote; the replicator reports what
// the server committed, including writes this process never made. A node with a replicator uses
// the replicator — `@ultimat3/realtime`'s `selectChangeFeed` still decides, and this is never in
// that decision.

import type { EntityCore } from './entity';
import type { Repo, RepoOptions, UpsertArgs } from './repo';
import type { IdOf, RowPatch } from './types';

export type RowChangeOp = 'insert' | 'update' | 'delete';

/**
 * One committed row change. `before`/`after` are whole rows, exactly as logical replication reports
 * them with `REPLICA IDENTITY FULL` — a consumer diffs them itself rather than trusting a patch it
 * did not compile.
 */
export interface RowChange {
  /** Entity name as declared, never a table name — the vocabulary a matcher's dependency set uses. */
  readonly entity: string;
  readonly op: RowChangeOp;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

/**
 * A write this seam cannot itemise: `deleteWhere` and `updateWhere` name a filter, not a row, and
 * reading the matching rows first would turn one statement into two and change what the code under
 * test issues. Reported as a bulk fact so a consumer can re-read rather than be told nothing —
 * silence is the one answer that diverges silently, which is the failure `invalidate()` exists for.
 */
export interface RowBulkChange {
  readonly entity: string;
  readonly op: 'delete' | 'update';
  readonly rows: number;
}

export interface RowObserver {
  onChange(change: RowChange): void;
  /** Optional: an observer that re-reads everything on any change has nothing to do here. */
  onBulk?(change: RowBulkChange): void;
}

let installed: RowObserver | null = null;

/**
 * Install the process's row observer, or clear it with `null`. One per process, exactly like
 * `@ultimat3/db`'s `setStatementObserver` — a second observer would be a second consumer disagreeing
 * about what a write is, and the caller that wants two composes them itself.
 *
 * Returns the observer that was installed, so a harness restores rather than clears: `bun test`
 * shares one process across files, and a fixture that cleared unconditionally would take an outer
 * harness's observer with it.
 */
export function setRowObserver(next: RowObserver | null): RowObserver | null {
  const previous = installed;
  installed = next;
  return previous;
}

export const rowObserver = (): RowObserver | null => installed;

/**
 * The reads a change needs and a plain write does not. `before` costs one `findById` per update and
 * per delete — paid ONLY while an observer is installed, which is why the guard is the first line of
 * every method below rather than a flag read once at wrap time. With no observer this wrapper is one
 * comparison and a delegation, on a path that already awaits a database.
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
 * too. It stays because the cost of being wrong is asymmetric: an observer is a diagnostic, and a
 * diagnostic that turns a working write into a failing one is worse than the gap it was closing.
 */
const beforeOf = async <Row>(
  entity: EntityCore<Row>,
  repo: Repo<Row>,
  id: IdOf<Row>,
): Promise<Row | null> => {
  if (!readsById(entity as EntityCore<unknown>)) return null;
  try {
    return await repo.findById(id);
  } catch {
    return null;
  }
};

/**
 * Wrap one repository so its writes are reported. Applied by `database()` to every table it builds,
 * so an app opts in by installing an observer and never by choosing a different repository — the
 * rows under test are the rows the app reads, which is the whole reason `defaultDriver()` is
 * exported at all.
 */
export function observedRepo<Row>(entity: EntityCore<Row>, repo: Repo<Row>): Repo<Row> {
  const name = entity.$name;

  const emit = (op: RowChangeOp, before: unknown, after: unknown): void => {
    installed?.onChange({ entity: name, op, before: asRecord(before), after: asRecord(after) });
  };

  const bulk = (op: 'delete' | 'update', rows: number): void => {
    if (rows > 0) installed?.onBulk?.({ entity: name, op, rows });
  };

  // Spread first, exactly as `examples/dummy`'s own capturing driver does: a repository may carry
  // members `Repo` does not name — `memoryRepo`'s `reset()` is one — and a wrapper that listed only
  // the interface would silently drop them.
  return {
    ...repo,

    insert: async (values: Row, options?: RepoOptions): Promise<Row> => {
      const stored = await repo.insert(values, options);
      emit('insert', null, stored);
      return stored;
    },

    insertAll: async (rows: readonly Row[], options?: RepoOptions): Promise<readonly Row[]> => {
      const stored = await repo.insertAll(rows, options);
      for (const row of stored) emit('insert', null, row);
      return stored;
    },

    /**
     * `before` is read per row and only for rows that carry an id, because a collision is what
     * separates an insert from an update here and nothing else in the result says which happened.
     * Under `onMatch: 'nothing'` a row already stored is absent from the result — so it wrote
     * nothing, and reporting a change for it would be reporting a write that did not occur.
     */
    upsertAll: async (rows: readonly Row[], args: UpsertArgs<Row>): Promise<readonly Row[]> => {
      if (installed === null) return await repo.upsertAll(rows, args);
      const before = new Map<string, unknown>();
      for (const row of rows) {
        const id = idOf(row);
        if (id !== undefined) before.set(id, await beforeOf(entity, repo, id as IdOf<Row>));
      }
      const stored = await repo.upsertAll(rows, args);
      for (const row of stored) {
        const id = idOf(row);
        const previous = id === undefined ? null : (before.get(id) ?? null);
        emit(previous === null ? 'insert' : 'update', previous, row);
      }
      return stored;
    },

    update: async (id, patch: RowPatch<Row>, options?: RepoOptions): Promise<Row> => {
      if (installed === null) return await repo.update(id, patch, options);
      const before = await beforeOf(entity, repo, id);
      const after = await repo.update(id, patch, options);
      emit('update', before, after);
      return after;
    },

    delete: async (id, options?: RepoOptions): Promise<void> => {
      if (installed === null) return await repo.delete(id, options);
      const before = await beforeOf(entity, repo, id);
      await repo.delete(id, options);
      emit('delete', before, null);
    },

    deleteWhere: async (filter: RowPatch<Row>, options?: RepoOptions): Promise<number> => {
      const rows = await repo.deleteWhere(filter, options);
      bulk('delete', rows);
      return rows;
    },

    updateWhere: async (
      filter: RowPatch<Row>,
      patch: RowPatch<Row>,
      options?: RepoOptions,
    ): Promise<number> => {
      const rows = await repo.updateWhere(filter, patch, options);
      bulk('update', rows);
      return rows;
    },
  };
}
