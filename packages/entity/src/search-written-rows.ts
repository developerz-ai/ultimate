// The rows a delete or a filtered write touched, handed up to the search mirror. A driver hands
// them over only while `collectWrittenRows` runs — the mirror opens it for a searchable entity
// under an external index, and nowhere else — so every other write sends no `returning *`.

import { asyncContext } from '@ultimat3/core';

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
