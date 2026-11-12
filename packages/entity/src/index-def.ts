// Single responsibility: the shape of one declared index — its key parts, method and build — as
// `entity({ indexes })` resolves it and `describe()` hands it to `@ultimat3/db`'s DDL. Split out of
// `types.ts` (the column vocabulary) at its size ceiling.

import type { IndexMethod, IndexOperatorClass } from '@ultimat3/db';

export interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly order?: 'asc' | 'desc';
  /** Partial index predicate — a soft-deleted row is excluded with this. */
  readonly where?: string;
  /**
   * The access method. Absent is `btree`, which is Postgres' own default and what every index
   * declared before this field existed is — so an entity that names none emits the statement it
   * always emitted, byte for byte, and no app's sidecar regenerates. `@ultimat3/db` owns the
   * closed set (`INDEX_METHODS`); redeclaring the union here would be the second declaration of
   * one fact that this release exists to stop.
   */
  readonly using?: IndexMethod;
  /**
   * How it is built (`IndexInit`). Absent is the default: concurrently on a table that already
   * exists. `false` is the opt-out, a plain build `x db gen` marks `-- lock-heavy: true`.
   */
  readonly concurrently?: boolean;
  /** The ONE key is this SQL expression over PHYSICAL columns; `columns` names the columns it reads. */
  readonly expression?: string;
  /** A direction per key, in key order; `null` writes none. Never beside `order`. */
  readonly orders?: readonly ('asc' | 'desc' | null)[];
  /** INCLUDE payload columns, physical, btree only. */
  readonly include?: readonly string[];
  /** An operator class on every key: `gin_trgm_ops`, gin only (what `contains` needs). */
  readonly operatorClass?: IndexOperatorClass;
}
