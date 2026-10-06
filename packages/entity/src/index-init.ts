// What one `indexes: [...]` entry of `entity(name, { indexes })` may say. Its own file so the
// declaration's shape is readable apart from `entity.ts`, which turns it into an `IndexDef`.

import type { IndexMethod } from '@ultimat3/db';
import type { Expr, InvariantColumns } from './expr';
import type { ColumnMap } from './types';

export interface IndexInit<C extends ColumnMap> {
  readonly on: readonly (keyof C & string)[];
  readonly order?: 'asc' | 'desc';
  readonly unique?: boolean;
  /** Partial index predicate, written in the same language as an invariant. */
  readonly where?: (columns: InvariantColumns<C>) => Expr;
  /**
   * The access method. Omitted is `btree`, which is Postgres' own default and what every index
   * declared before this existed is — so an entity that names none emits the statement it always
   * emitted and nothing regenerates.
   *
   * `'gin'` is the one with a caller, and it is the whole point of the containment operators:
   * measured on Postgres 16 over 20,000 rows, `tags @> …`, `tags <@ …`, `tags && …` and
   * `data @> …` are each a Bitmap Index Scan with one and a Seq Scan without. The set is
   * `@ultimat3/db`'s `INDEX_METHODS`, imported rather than restated — one declaration of one fact.
   *
   * Two Postgres rules ride with it and both are refused HERE, where the author is, rather than at
   * `x db gen` or inside `ROLE=migrate` as the server's own syntax error: a GIN index cannot be
   * unique and cannot order its keys.
   */
  readonly using?: IndexMethod;
}
