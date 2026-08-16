/**
 * The one row a detail route renders. A read answers rows — `limit(1)` included — while a page
 * that renders one post needs the row itself, so the empty answer is a 404 decided here rather
 * than in every `load`. Kept in `shared/` because both surfaces have such a route.
 */

import { invariant } from '@ultimat3/core';

export function oneRow<TRow>(rows: readonly TRow[], reference: string): TRow {
  const [row] = rows;
  invariant(
    row !== undefined,
    'X_NOT_FOUND',
    `no row for ${JSON.stringify(reference)} — the read backing this route answered no rows, ` +
      'which for a bounded single-row read is "absent", never "not yet"',
    'confirm the row exists and this actor may read it: ' +
      'x dev, then run the read in the /_x/db panel',
  );
  return row;
}
