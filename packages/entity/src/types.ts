// The structural vocabulary of a column. The physical layer is this package's own hand-written
// `postgresDriver()` (`pg-driver.ts` / `pg-sql.ts`), not an ORM; declaring the narrow shape we
// consume keeps the emitted SQL readable and keeps this package free of a dependency an agent
// must learn to read.
//
// A column carries its TypeScript type in `$parse`, which is what lets the row type be derived
// from the column set instead of being written a second time as a hand-maintained schema.

/** Postgres types the blessed builders emit. `money` expands to `bigint` + `char(3)`. */
export type ColumnKind =
  | 'uuid'
  | 'text'
  | 'char'
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'timestamptz'
  | 'jsonb'
  | 'money';

export type ColumnDefault =
  | { readonly kind: 'value'; readonly value: string | number | boolean | null }
  | { readonly kind: 'generated'; readonly by: 'uuid-v7' | 'now' };

export type OnDelete = 'cascade' | 'restrict' | 'set null';

export interface ReferenceOptions {
  readonly onDelete?: OnDelete;
}

/** The single value a money column puts on the row. Two physical columns back it. */
export interface MoneyValue {
  readonly minor: bigint;
  readonly currency: string;
}

/** What a writer may hand a money column. An integer `number` widens; a float throws. */
export interface MoneyInput {
  readonly minor: bigint | number;
  readonly currency: string;
}

/**
 * What the author declared. Where it landed — table, property key, physical name — is the
 * binding `entity()` records (see `column.ts`), so a name is never written twice.
 */
export interface ColumnMeta {
  readonly kind: ColumnKind;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly index: boolean;
  /** Presence of a tenant column is what turns tenancy on. See `tenancy.ts`. */
  readonly tenant: boolean;
  readonly length?: number;
  readonly values?: readonly string[];
  readonly default?: ColumnDefault;
  readonly onUpdate?: ColumnDefault;
  /** Takes the physical name, so a CHECK can be written before that name is known. */
  readonly check?: (column: string) => string;
  /** A thunk: schema modules reference each other in a cycle. */
  readonly references?: () => AnyColumn;
  readonly onDelete?: OnDelete;
}

/**
 * `Optional` is the phantom that says "this column has a default", so an insert may omit it.
 * It is a real boolean at runtime too, so nothing has to be re-derived to check it.
 */
export interface Column<T, Optional extends boolean = false> {
  readonly $meta: ColumnMeta;
  /** Runtime guard AND the carrier of the column's TypeScript type. */
  readonly $parse: (value: unknown) => T;
  readonly $optional: Optional;
  /** `boolean`: only a uuid key carries a generated default, so only it becomes optional. */
  primaryKey(): Column<T, boolean>;
  nullable(): Column<T | null, Optional>;
  unique(): Column<T, Optional>;
  /** Marks the tenant column; a query without an org predicate then throws. */
  tenant(): Column<T, Optional>;
  references(target: () => AnyColumn, options?: ReferenceOptions): Column<T, Optional>;
  default(value: T): Column<T, true>;
}

/** A uuid primary key is generated (v7) when omitted, which is why it narrows to `true`. */
export interface UuidColumn<Optional extends boolean = false> extends Column<string, Optional> {
  primaryKey(): Column<string, true>;
}

export interface TimestampColumn<Optional extends boolean = false> extends Column<Date, Optional> {
  defaultNow(): TimestampColumn<true>;
  onUpdateNow(): TimestampColumn<Optional>;
}

export type AnyColumn = Column<unknown, boolean>;

export type ColumnMap = Readonly<Record<string, AnyColumn>>;

export type TypeOf<C> = C extends Column<infer T, boolean> ? T : never;

/** The row type a column set describes. This derivation is why the package exists. */
export type RowOf<C extends ColumnMap> = {
  readonly [K in keyof C]: TypeOf<C[K]>;
};

type DefaultedKeys<C extends ColumnMap> = {
  [K in keyof C]-?: C[K]['$optional'] extends true ? K : never;
}[keyof C];

/** Money is the one column whose write shape is wider than its row shape. */
type InputOf<T> = T extends MoneyValue ? MoneyInput : T;

/** What an insert must supply: every column except the ones carrying a default. */
export type Insertable<C extends ColumnMap> = {
  readonly [K in Exclude<keyof C, DefaultedKeys<C>>]: InputOf<TypeOf<C[K]>>;
} & {
  readonly [K in DefaultedKeys<C>]?: InputOf<TypeOf<C[K]>>;
};

export interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly order?: 'asc' | 'desc';
  /** Partial index predicate — a soft-deleted row is excluded with this. */
  readonly where?: string;
}
