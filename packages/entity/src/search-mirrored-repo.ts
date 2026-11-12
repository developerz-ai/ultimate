// Every write of a searchable entity, mirrored to an installed external index at COMMIT. A delete
// and a filtered write run inside `collectWrittenRows`, so the driver answers the rows it touched
// (`returning *`) — for a composite or non-`id` key too. Not searchable, or the built-in index
// installed: the repository is handed back, or the write delegates with no extra statement.

import { copyColumns } from './copy-plan';
import type { EntityCore } from './entity';
import type { Repo, RepoOptions } from './repo';
import type { SearchMirror } from './search-index-sync';
import { mirrorFor, mirrors } from './search-index-sync';
import { collectWrittenRows } from './search-written-rows';
import type { RowPatch } from './types';

type Told = (mirror: SearchMirror, rows: readonly unknown[]) => void;

/** A write that answers its rows: each one mirrored as changed. */
const stored = async <T extends readonly unknown[]>(
  entity: EntityCore<unknown>,
  op: string,
  options: RepoOptions | undefined,
  write: () => Promise<T>,
): Promise<T> => {
  const rows = await write();
  if (mirrors(entity)) mirrorFor(entity, options)?.changed(op, rows);
  return rows;
};

/**
 * A write that answers a count, run so its driver hands the rows over. `rows` absent is a store
 * that named none (a custom driver's, or a write past the bound): logged, never silent, never the
 * write's failure.
 */
const collected = async <T>(
  entity: EntityCore<unknown>,
  op: string,
  options: RepoOptions | undefined,
  write: () => Promise<T>,
  told: Told,
  touched: (result: T) => number,
): Promise<T> => {
  if (!mirrors(entity)) return await write();
  const { result, rows } = await collectWrittenRows(write);
  const mirror = mirrorFor(entity, options);
  if (mirror === undefined) return result;
  if (rows !== undefined) told(mirror, rows);
  else if (touched(result) > 0) mirror.unnamed(op, touched(result));
  return result;
};

export function searchMirroredRepo<Row>(entity: EntityCore<Row>, repo: Repo<Row>): Repo<Row> {
  if (entity.$search === null) return repo;
  const core = entity as EntityCore<unknown>;
  const single = async <T>(row: Promise<T>): Promise<readonly [T]> => [await row];
  const changed =
    (op: string): Told =>
    (mirror, rows) =>
      mirror.changed(op, rows);
  const deleted =
    (op: string): Told =>
    (mirror, rows) =>
      mirror.deleted(op, rows);

  /**
   * A count-only write names no rows, and the mirror needs them: while an external index is
   * installed it runs as its returning counterpart — the same judging, the rows mirrored, their
   * length answered. With none installed it is the count path, untouched.
   */
  const { insertAllCount, upsertAllCount, copyAll, updateMany } = repo;
  const counts: Partial<Repo<Row>> = {
    ...(insertAllCount === undefined
      ? {}
      : {
          insertAllCount: async (rows, options) =>
            mirrors(core)
              ? (await stored(core, 'insertAll', options, () => repo.insertAll(rows, options)))
                  .length
              : insertAllCount.call(repo, rows, options),
        }),
    ...(upsertAllCount === undefined
      ? {}
      : {
          upsertAllCount: async (rows, args) =>
            mirrors(core)
              ? (await stored(core, 'upsertAll', args, () => repo.upsertAll(rows, args))).length
              : upsertAllCount.call(repo, rows, args),
        }),
    ...(copyAll === undefined
      ? {}
      : {
          copyAll: async (rows, options) => {
            if (!mirrors(core)) return copyAll.call(repo, rows, options);
            // COPY's own refusal first, so a load is refused alike with or without an index.
            copyColumns(entity, rows as readonly RowPatch<Row>[]);
            return (await stored(core, 'copyAll', options, () => repo.insertAll(rows, options)))
              .length;
          },
        }),
    ...(updateMany === undefined
      ? {}
      : {
          updateMany: (rows, options) =>
            collected(
              core,
              'updateMany',
              options,
              () => updateMany.call(repo, rows, options),
              changed('updateMany'),
              (count) => count,
            ),
        }),
  };

  return {
    ...repo,
    ...counts,
    insert: async (values, options) =>
      (await stored(core, 'insert', options, () => single(repo.insert(values, options))))[0],
    insertAll: (rows, options) =>
      stored(core, 'insertAll', options, () => repo.insertAll(rows, options)),
    upsertAll: (rows, args) => stored(core, 'upsertAll', args, () => repo.upsertAll(rows, args)),
    update: async (id, patch, options) =>
      (await stored(core, 'update', options, () => single(repo.update(id, patch, options))))[0],
    delete: (id, options) =>
      collected(
        core,
        'delete',
        options,
        () => repo.delete(id, options),
        deleted('delete'),
        () => 1,
      ),
    deleteWhere: (filter, options) =>
      collected(
        core,
        'deleteWhere',
        options,
        () => repo.deleteWhere(filter, options),
        deleted('deleteWhere'),
        (count) => count,
      ),
    updateWhere: (filter, patch, options) =>
      collected(
        core,
        'updateWhere',
        options,
        () => repo.updateWhere(filter, patch, options),
        changed('updateWhere'),
        (count) => count,
      ),
  };
}
