// Single responsibility: the structural mirror of `@ultimat3/entity`'s entity description. `db` is
// tier 1 and may never import `entity` (tier 2), so a snapshot arrives as a parameter and every
// part of it — a column's `on delete` rule included — crosses the seam by shape or not at all.

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
}

/** Structurally assignment-compatible with `@ultimat3/entity`'s `EntityDescription`. */
export interface EntityDescriptionLike {
  readonly name: string;
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnDescriptionLike[];
  readonly indexes: readonly IndexDescriptionLike[];
}
