// Single responsibility: keep `inBatches(size)` under the page byte bound by shrinking the batch.
// A batch IS a page, so a sweep over heavy rows would hit `X_ENTITY_PAGE_TOO_LARGE` on a size that
// was right for light ones; halving and re-reading the same cursor finishes the sweep instead, and
// every caller — the framework's reindex and history reads, an app's own loop — needs no edit.

import type { Page } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';

const tooLarge = (error: unknown): boolean =>
  isUltimateError(error) && error.code === 'X_ENTITY_PAGE_TOO_LARGE';

/**
 * The batch reader `inBatches` hands `batchIterator`: `read` at `size` rows, and on a page refused
 * for its bytes the same cursor again at half the rows — down to one, where a row heavier than the
 * bound on its own is refused as it should be. The smaller size is kept for the batches after it:
 * the rows that were heavy are usually the table's shape, and starting over at `size` would pay
 * the refused reads once per batch. At most `⌈log2(size)⌉` statements are refused per iteration.
 */
export const shrinkingPages = <Row>(
  size: number,
  read: (limit: number, cursor: string | null) => Promise<Page<Row>>,
): ((cursor: string | null) => Promise<Page<Row>>) => {
  let limit = size;
  return async (cursor) => {
    for (;;) {
      try {
        return await read(limit, cursor);
      } catch (error) {
        if (limit <= 1 || !tooLarge(error)) throw error;
        limit = Math.floor(limit / 2);
      }
    }
  };
};
