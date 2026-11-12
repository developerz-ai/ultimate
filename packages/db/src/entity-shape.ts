// Single responsibility: the structural mirror of `@ultimat3/entity`'s entity description. `db` is
// tier 1 and may never import `entity` (tier 2), so a snapshot arrives as a parameter and every
// part of it — a column's `on delete` rule included — crosses the seam by shape or not at all.

import type { ColumnDefaultLike } from './column-default';
import type { IndexOperatorClass } from './index-key-ddl';
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
  /**
   * Both ends of this `references()` are tenant-scoped, so the key is composite: `(column, this) ->
   * target (targetColumn, its key)`. Absent or `null` is the plain key every older description
   * declares. `@ultimat3/entity` decides it (`describeReferences`), and only the two physical names
   * cross, because the rest of the key is already on this column.
   */
  readonly sameTenant?:
    | { readonly column: string; readonly targetColumn: string }
    | null
    | undefined;
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
  /**
   * HOW the index is built, never WHAT it is — not part of the name, not recorded in a snapshot
   * and never a reason to rebuild one. Absent or `true`: on a table that already exists, `create
   * index concurrently` in a migration of its own OUTSIDE a transaction (`concurrent-index.ts`), so
   * a hot table keeps taking writes. `false`: the plain, transactional build, which `index-plan.ts`
   * marks `-- lock-heavy: true` for `X_MIGRATION_LOCK_HEAVY`. A table the same migration creates,
   * and a partitioned parent (`0A000`), are always built plainly.
   */
  readonly concurrently?: boolean | undefined;
  /**
   * The four parts past a plain column list (`index-key-ddl.ts` renders them). Each is optional
   * and absent by default, for `using`'s reason: a description written before them emits, records
   * and compares exactly as it did.
   *
   * `expression`: the ONE key is this SQL expression (`lower(email)`, `(payload->>'kind')`), and
   * `columns` names the columns it reads — what a foreign key's covering rule looks at.
   */
  readonly expression?: string | undefined;
  /** A direction per key, in key order; `null` writes none. Replaces `order`, never beside it. */
  readonly orders?: readonly ('asc' | 'desc' | null)[] | undefined;
  /** INCLUDE payload columns — stored in the index, never keyed (btree only). */
  readonly include?: readonly string[] | undefined;
  /** An operator class on every key. One member: `gin_trgm_ops`, which `contains` needs (gin only). */
  readonly operatorClass?: IndexOperatorClass | undefined;
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
  /**
   * `entity({ appendOnly: true })`: the table refuses UPDATE and DELETE (`generate-append-only.ts`).
   * Optional for the reason `invariants` is, and absent reads as "rows may change".
   */
  readonly appendOnly?: boolean | undefined;
  /**
   * `entity({ retired: ['legacy'] })`: physical columns old pods may still read and this release
   * does not (`retired.ts`). Absent is none, for the reason `invariants` is optional.
   */
  readonly retired?: readonly string[] | undefined;
  /**
   * `entity(name, { view: { sql } })`: a relation Postgres derives, emitted by `generate-view.ts`
   * and handed to no table arm. Absent is a table, for the reason `invariants` is optional.
   */
  readonly view?: { readonly sql: string; readonly materialized?: true | undefined } | undefined;
  /**
   * `entity({ history: true })`: every row change is recorded into `history.table` by a trigger
   * (`generate-history.ts`). Absent is no history, for the reason `invariants` is optional.
   */
  readonly history?: HistoryDescriptionLike | undefined;
  /**
   * `references(…, { countedIn })` on a child key: counters the database keeps on this table
   * (`generate-counter.ts`). Absent is none.
   */
  readonly counts?: readonly CounterDescriptionLike[] | undefined;
  /** `entity({ retain })`: rows older than the window are swept by `purge()`. Absent is kept. */
  readonly retain?: RetainDescriptionLike | undefined;
  /**
   * `entity({ partitionBy })`: a range-partitioned table (`generate-partition.ts`). Absent is a
   * plain table, for the reason `invariants` is optional.
   */
  readonly partition?: PartitionDescriptionLike | undefined;
}

/** The bucket widths. `week` is ISO: it starts on a Monday, as `date_trunc('week', …)` does. */
export const PARTITION_INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type PartitionInterval = (typeof PARTITION_INTERVALS)[number];

/** Structurally assignment-compatible with `@ultimat3/entity`'s `PartitionDescription`. */
export interface PartitionDescriptionLike {
  /** The physical partition column, part of the primary key. */
  readonly column: string;
  readonly interval: PartitionInterval;
  /** Partitions kept ready past the current one. */
  readonly ahead: number;
  /** Whole partitions whose upper bound is older than `afterMs` are detached, then dropped. */
  readonly retain?: { readonly after: string; readonly afterMs: number } | undefined;
}

/** Where a table's row images go, and what its trigger needs to write one. Physical names. */
export interface HistoryDescriptionLike {
  /** The history table: `<table>_history`, an entity of its own. */
  readonly table: string;
  /** The parent's single primary-key column, recorded as `row_id`. */
  readonly key: string;
  /** The parent's tenant column, copied onto every history row, or `null`. */
  readonly tenant: string | null;
  /** Columns whose change alone records nothing: the counters the database keeps. */
  readonly ignore: readonly string[];
  /** `int8`/`numeric` columns the image stores as their digits, never a JSON number. */
  readonly text?: readonly string[] | undefined;
  /** `timestamptz` columns the image stores as a UTC ISO string, whatever the session zone. */
  readonly instants?: readonly string[] | undefined;
  /**
   * Sealed columns, left out of both images: their stored string is ciphertext, and a lookup
   * one is deterministic — two rows' equal values would be equal in history. Absent is none.
   */
  readonly sealed?: readonly string[] | undefined;
}

/** One counter, physical names: `<this table>.<column>` counts `<table>` rows by `<references>`. */
export interface CounterDescriptionLike {
  readonly column: string;
  /** The parent's key column the child's foreign key points at. */
  readonly key: string;
  /** The child table the trigger sits on. */
  readonly table: string;
  /** The child's foreign-key column. */
  readonly references: string;
  /** The child's soft-delete column: a stamped row is not counted. `null` when it has none. */
  readonly softDelete: string | null;
}

/** `retain: { after, on }`, with `on` physical. */
export interface RetainDescriptionLike {
  readonly after: string;
  readonly on: string;
}
