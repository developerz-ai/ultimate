// Single responsibility: what a `single: true` read ANSWERS — its first row, or `X_NOT_FOUND`.
// One rule for the route, the read's own tool and `@ultimat3/mcp`'s served tool: three copies of
// "take the first row, refuse when there is none" are three places for one surface to drift.

import { QueryRowNotFoundError } from './errors';
import type { AnyQuery } from './query';
import { queryName } from './read';

/** The first row — what every in-process `[0]` of the same read takes — or `X_NOT_FOUND`. */
export function oneRowOf<TRow extends object>(name: string, rows: readonly TRow[]): TRow {
  const [row] = rows;
  if (row === undefined) throw new QueryRowNotFoundError(name);
  return row;
}

/**
 * A read's answer on a surface that hands back one value: the rows of a list read, the one row of
 * a `single: true` read. `rows` is what the read's own source executed to.
 */
export function readAnswer(target: AnyQuery, rows: readonly object[]): readonly object[] | object {
  return target.single === true ? oneRowOf(queryName(target), rows) : rows;
}
