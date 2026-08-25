// Single responsibility: the structural mirror of `@ultimat3/entity`'s entity description. `db` is
// tier 1 and may never import `entity` (tier 2), so a snapshot arrives as a parameter and every
// part of it — a column's `on delete` rule included — crosses the seam by shape or not at all.

import type { ColumnDefaultLike } from './column-default';
import type { IndexMethod } from './index-method';

/** Structurally assignment-compatible with `@ultimat3/entity`'s `ColumnDescription`. */
export interface ColumnDescriptionLike {
  readonly property: string;
  readonly column: string;
  readonly kind: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly check: string | null;
  readonly references: string | null;
  /**
   * The `references()` rule, `null` or absent when none was declared. Optional so a description
   * written before it existed still satisfies the shape — this package cannot import `entity`, so
   * the field travelling structurally is the *only* way the rule crosses the tier boundary.
   */
  readonly onDelete?: string | null | undefined;
  /**
   * The `generated always as (<expr>) stored` body, when the DATABASE computes this column rather
   * than a writer. Absent on every ordinary column, exactly like `IndexDescriptionLike.using`: a
   * description written before this existed emits the statement it always emitted.
   *
   * `@ultimat3/entity` (tier 2) is the declarer and this package cannot import it, so the
   * expression crosses the seam structurally or it reaches no DDL at all — which is where it was
   * until `As of 2026-08-24`: the column landed as a plain `tsvector not null` and the first insert
   * was a `23502`, because nothing computed it.
   */
  readonly generated?: string | undefined;
  /**
   * What the column defaults to, when the declaration carries the value and not only the flag.
   * Optional for the reason `onDelete` and `generated` are: this package cannot import
   * `@ultimat3/entity`, so a field that is not on the projection reaches no DDL at all.
   *
   * `hasDefault` beside it is NOT redundant and is not being replaced. It is the older, narrower
   * fact — "this column defaults to something" — and it is what `generatedClause` reads to refuse
   * a column that is both generated and defaulted. Where `hasDefault` is true and this is absent,
   * `defaultExpression` falls back to the two defaults inferable from the kind and everything else
   * is REPORTED as unrendered rather than dropped (`unrendered.ts`).
   */
  readonly default?: ColumnDefaultLike | undefined;
}

/**
 * Structurally assignment-compatible with `@ultimat3/entity`'s `InvariantDescription`.
 *
 * An invariant is written once and enforced twice — in the app on every write, and in Postgres as
 * a CHECK or a unique index. The second half reached no SQL at all until 2026-08-25, because this
 * mirror had no `invariants` field: a regenerated migration silently held none of them, including
 * the composite UNIQUE that `upsertAll`'s `on conflict` is inferred against, so a replay-safe
 * write became a duplicate row on a database the framework itself generated.
 */
export interface InvariantDescriptionLike {
  /** The rule's own name. `<table>_<name>_check` / `_key` is the constraint it becomes. */
  readonly name: string;
  /** `assert` is a rule only the app can run — no SQL, and nothing for a migration to emit. */
  readonly kind: 'check' | 'unique' | 'assert';
  readonly message: string;
  /** The predicate for a `check`, the column list for a `unique`, `null` for an `assert`. */
  readonly sql: string | null;
  /** Partial-constraint predicate, e.g. `deleted_at is null`. `null` covers every row. */
  readonly where: string | null;
  /**
   * The physical columns a `unique` names, when the declaration carries them. Optional, and
   * `uniqueColumns()` falls back to splitting `sql` when it is absent — see the argument in
   * `invariant-ddl.ts` for why that fallback is a validated re-read and not a name parsed back.
   */
  readonly columns?: readonly string[] | undefined;
}

/**
 * Structurally assignment-compatible with `@ultimat3/entity`'s `IndexDescription`.
 *
 * The column list is carried, never recovered from `name`. Entity names an index
 * `<table>_<a>_<b>_idx`, and that convention does not run backwards: two columns joined by `_`
 * are one string, so a composite index read back out of its own name became the single column
 * `"org_id_created_at"` — DDL Postgres answers `42703` and a migration nobody can apply.
 */
export interface IndexDescriptionLike {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  /** Partial index predicate as SQL, `null` when the index covers every row. */
  readonly where: string | null;
  /** `null` is Postgres' own default (`asc`), never written out. */
  readonly order: 'asc' | 'desc' | null;
  /**
   * The access method. Absent is `btree`, which is Postgres' own default and what every index
   * declared before this field existed is — so a description written without it still satisfies
   * the shape, exactly as `ColumnDescriptionLike.onDelete` does. `@ultimat3/entity` (tier 2) is
   * the declarer; this package cannot import it, so the method crosses the seam structurally.
   */
  readonly using?: IndexMethod | undefined;
}

/** Structurally assignment-compatible with `@ultimat3/entity`'s `EntityDescription`. */
export interface EntityDescriptionLike {
  readonly name: string;
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnDescriptionLike[];
  readonly indexes: readonly IndexDescriptionLike[];
  /**
   * The domain rules the database must hold too. Optional so no existing description changes
   * shape, exactly as `onDelete`, `generated` and `using` are — and absent reads as "declares
   * none", which is what every hand-built description in this package's own tests is.
   */
  readonly invariants?: readonly InvariantDescriptionLike[] | undefined;
}
