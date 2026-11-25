// Collect rows touched by a delete or filtered write for the search mirror or a returning update.
// Drivers hand them over only while `collectWrittenRows` runs, so other writes need no `returning *`.

import { asyncContext } from '@ultimat3/core';
import { describeCommand, EntityError } from './errors';

/** What one write answered: its rows, or nothing — a store that cannot say which rows it touched. */
interface WrittenRows {
  rows: unknown[] | undefined;
}

const collecting = asyncContext<WrittenRows>('the search index write path');

/**
 * The sink a driver hands a write's rows to, or `undefined` when nobody asked — the one check a
 * driver pays per delete and filtered write. A driver that holds the rows anyway calls it too.
 */
export const writtenRowsSink = (): ((rows: readonly unknown[]) => void) | undefined => {
  const open = collecting.get();
  if (open === undefined) return undefined;
  return (rows) => {
    open.rows = [...(open.rows ?? []), ...rows];
  };
};

/**
 * Run one write and answer what it returned plus the rows its driver handed over. `rows` is
 * `undefined` when the driver handed none — a custom store's raw update, which reports a count.
 */
export const collectWrittenRows = async <T>(
  write: () => Promise<T>,
): Promise<{ readonly result: T; readonly rows: readonly unknown[] | undefined }> => {
  const open: WrittenRows = { rows: undefined };
  const result = await collecting.run(open, write);
  return { result, rows: open.rows };
};

/** Answer the rows a filtered write reported, refusing an incomplete result. */
export const updatedRows = async <Row>(
  entityName: string,
  write: () => Promise<number>,
): Promise<readonly Row[]> => {
  const { result, rows } = await collectWrittenRows(write);
  if (result === 0) return [];
  if (rows === undefined || rows.length !== result) {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${entityName}.updateWhereReturning() wrote ${result} rows and this repository named ${rows?.length ?? 0} of them — a write that matches that many rows (or a store that cannot report them) has no rows to hand back`,
      fix: `${describeCommand(entityName)}   # then write by a narrower filter, or sweep it with .where(filter).inBatches(1000) and write each page`,
    });
  }
  return rows as readonly Row[];
};
