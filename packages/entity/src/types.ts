// The narrow structural types this package consumes. Drizzle is the production
// backing for `TableDef`/`ColumnDef` (see README), but declaring the shape we use
// instead of depending on the ORM keeps the generated SQL readable and keeps this
// package free of a dependency an agent would have to learn to read.

/** Postgres types the blessed column helpers emit. No `float` for money, ever. */
export type ColumnKind =
  | 'uuid'
  | 'text'
  | 'char'
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'timestamptz'
  | 'date'
  | 'jsonb';

export type ColumnDefault =
  | { readonly kind: 'sql'; readonly expression: string }
  | { readonly kind: 'value'; readonly value: string | number | boolean | null }
  | { readonly kind: 'generated'; readonly by: 'uuid-v7' | 'now' };

export interface ReferenceDef {
  readonly table: string;
  readonly column: string;
  readonly onDelete?: 'cascade' | 'restrict' | 'set null';
}

export interface ColumnDef<T> {
  /** snake_case physical name; the property key is the camelCase domain name. */
  readonly name: string;
  readonly kind: ColumnKind;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly length?: number;
  readonly default?: ColumnDefault;
  /** SQL expression emitted as a CHECK next to the column. */
  readonly check?: string;
  readonly references?: ReferenceDef;
  readonly index: boolean;
  readonly comment?: string;
  /**
   * Runtime guard AND the carrier of the column's TypeScript type. Every write goes
   * through it, which is how `money()` can refuse a float instead of rounding it.
   */
  readonly parse: (value: unknown) => T;
}

export type ColumnMap = Readonly<Record<string, ColumnDef<unknown>>>;

export interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  /** Partial index predicate — soft-deleted rows are excluded with this. */
  readonly where?: string;
}

export interface TableDef<C extends ColumnMap = ColumnMap> {
  readonly name: string;
  readonly columns: C;
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexDef[];
}

/** The row type a table describes, derived from its columns' parse signatures. */
export type RowOf<C extends ColumnMap> = {
  readonly [K in keyof C]: C[K] extends ColumnDef<infer T> ? T : never;
};

export const columnNames = (table: TableDef): readonly string[] =>
  Object.values(table.columns).map((column) => column.name);

export const hasColumn = (table: TableDef, property: string): boolean =>
  Object.hasOwn(table.columns, property);
