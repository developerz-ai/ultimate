// Single responsibility: the catalog ROWS `introspectSchema()` reads, and the pure helpers that turn
// one into a description field — a key's rule with its list, a table's `NOT VALID` names. Split
// from `introspect.ts`, which issues the queries and folds the rows into tables.

export interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
  readonly ordinal_position: number;
}

export interface IndexRow {
  readonly table_name: string;
  readonly index_name: string;
  readonly is_unique: boolean;
  readonly is_primary: boolean;
  readonly columns: readonly string[];
  readonly predicate: string | null;
  readonly descending: boolean;
  readonly method?: string | undefined;
}

export interface ForeignKeyRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly columns: readonly string[];
  readonly referenced_table: string;
  readonly referenced_columns: readonly string[];
  readonly on_delete: string | null;
  /** `set null (a, b)`'s list as the server prints it. Postgres 15+; `null` for any other rule. */
  readonly set_null_columns?: string | null | undefined;
  readonly validated?: boolean | undefined;
}

/**
 * A key's rule in the spelling a description holds, list included. The list reads the definition
 * text, not `confdelsetcols`, which is a column only Postgres 15+ has: this query runs against
 * whatever an operator points it at. The server quotes a reserved word and a description never
 * does, so each name is unquoted or `user` is a permanent `changed-foreign-key`.
 */
const unquotedName = (name: string): string => {
  const trimmed = name.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"')
    : trimmed;
};

export const onDeleteOf = (row: ForeignKeyRow): string | null =>
  row.set_null_columns == null
    ? row.on_delete
    : `set null (${row.set_null_columns.split(',').map(unquotedName).join(', ')})`;

/** A CHECK constraint's NAME. There is deliberately no column for its definition — see `checkNames`. */
export interface CheckRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly validated?: boolean | undefined;
}

/** An enabled trigger's NAME — the half of `appendOnly` the catalog can answer. */
export interface TriggerNameRow {
  readonly table_name: string;
  readonly trigger_name: string;
}

/** Absent when none: `false` only, so a row a fake client wrote without the field is not one. */
export const notValidOf = (
  rows: readonly {
    readonly table_name: string;
    readonly constraint_name: string;
    readonly validated?: boolean | undefined;
  }[],
  table: string,
): { readonly notValidNames?: readonly string[] } => {
  const names = rows
    .filter((row) => row.table_name === table && row.validated === false)
    .map((row) => row.constraint_name)
    .sort();
  return names.length === 0 ? {} : { notValidNames: names };
};
