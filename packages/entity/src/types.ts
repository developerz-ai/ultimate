// The structural vocabulary of a column. The physical layer is this package's own hand-written
// `postgresDriver()` (`pg-driver.ts` / `pg-sql.ts`), not an ORM; declaring the narrow shape we
// consume keeps the emitted SQL readable and keeps this package free of a dependency an agent
// must learn to read.
//
// A column carries its TypeScript type in `$parse`, which is what lets the row type be derived
// from the column set instead of being written a second time as a hand-maintained schema.

/**
 * Postgres types the builders emit. `money` expands to `bigint` + `char(3)` (+ a nullable
 * `integer` scale); `array` expands to its element's type with `[]` after it.
 *
 * The four beyond the blessed set exist for ONE reason: a schema Ultimate did not generate already
 * has them. A table with a `numeric(18,8)` rate, a `date` a rate takes effect on, a `jsonb` payload
 * and a `bytea` blob cannot be declared at all without them, and an entity that cannot be declared
 * is a rewrite instead of an adoption.
 */
export const COLUMN_KINDS = [
  'uuid',
  'text',
  'char',
  'boolean',
  'integer',
  'bigint',
  'numeric',
  'timestamptz',
  'date',
  'jsonb',
  'bytea',
  'array',
  'money',
] as const;

/**
 * Derived from the array and never written twice — the same shape `PRIMITIVE_KINDS` in
 * `@ultimat3/core`'s `registrar.ts` uses, and for the same reason: a package that has to answer
 * "one case per kind" needs a RUNTIME list, and a list written beside the type is one that drifts
 * from it. `@ultimat3/query`'s `shape-order.test.ts` spelled its own out and counted nine against
 * thirteen — `9 === 9`, a test that could not fail.
 */
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export type ColumnDefault =
  | { readonly kind: 'value'; readonly value: string | number | boolean | null }
  | { readonly kind: 'generated'; readonly by: 'uuid-v7' | 'now' };

export type OnDelete = 'cascade' | 'restrict' | 'set null';

export interface ReferenceOptions {
  readonly onDelete?: OnDelete;
}

/**
 * The single value a money column puts on the row. Two physical columns back it.
 *
 * An **alias** of `@ultimat3/schema`'s declaration, which is also what `@ultimat3/money`'s `Money`
 * is — so a row this package decodes IS a `Money`, assignable to `add()`, `formatMoney()` and
 * `<Money>` without a cast. It used to be a third, structurally different interface whose `minor`
 * was a `bigint`, and that was a live defect rather than a stylistic one: `JSON.stringify` throws
 * on a bigint, so returning a row with a money column from an action crashed the response, and
 * `t.money` — the schema node that becomes the OpenAPI contract — rejected the framework's own row.
 */
import type { MoneyValue } from '@ultimat3/schema';

export type { MoneyValue };

/**
 * What a writer may hand a money column. An integer `number` is the value type; a `bigint` is
 * accepted so a minor unit read straight off a `bigint` column (hand-written SQL, a backfill)
 * needs no conversion at the call site. A float throws, and so does a `bigint` past
 * `Number.MAX_SAFE_INTEGER` — see `parseMinor` in `columns.ts`.
 */
/**
 * The physical columns behind a money property, when they are not `<name>_minor`,
 * `<name>_currency` and `<name>_scale`. Named per part and merged over those defaults, so a table
 * that renamed one column does not have to restate the other two.
 */
export interface MoneyColumnNames {
  readonly minor?: string;
  readonly currency?: string;
  /**
   * `null` says this table has NO scale column — the ordinary shape of a money column written
   * before scale existed. Every amount in it is then at the currency's own minor unit, which is
   * what an absent scale already means, so nothing is lost but the ability to store a sub-cent one.
   */
  readonly scale?: string | null;
}

export interface MoneyInput {
  readonly minor: bigint | number;
  readonly currency: string;
  /**
   * Carried through the write, never invented: `undefined` means the currency's own minor unit and
   * `0` means whole units, and the two must not collapse. `null` is accepted because that is what
   * the `<name>_scale` column holds for an amount that declared none.
   */
  readonly scale?: number | null;
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
  /**
   * The physical column, when it is not `snake(property)`. The whole of what makes an existing
   * table addressable: `githubLogin` on a row, `gh_login` in every statement, decided once here
   * and read through `columnName()` by every projection.
   */
  readonly name?: string;
  readonly length?: number;
  /** `numeric(precision, scale)` — both, or neither. A bare `numeric` is unbounded on purpose. */
  readonly precision?: number;
  readonly numericScale?: number;
  /** The element column of an `array`, which carries the element's own kind and `$parse`. */
  readonly element?: AnyColumn;
  /** Where money's three physical columns live, when the table already named them. */
  readonly parts?: MoneyColumnNames;
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
  /**
   * The physical column name, when the table does not spell it `snake(property)`. Name it LAST in
   * a chain: this link returns the general column, so a builder's own methods (`defaultNow()`,
   * a uuid key's narrowed `primaryKey()`) are declared before it — `uuid()` and `timestamp()`
   * override it to keep theirs, and nothing else has any.
   */
  column(name: string): Column<T, Optional>;
}

/**
 * A uuid primary key is generated (v7) when omitted, which is why it narrows to `true`.
 *
 * `T` is the declared id type: `uuid<PostId>()` carries the brand from here to the row, the
 * insert and every repository signature, so a `PostId` cannot be passed where a `UserId` is
 * wanted. It defaults to `string`, so an unbranded declaration reads exactly as it did.
 */
export interface UuidColumn<T extends string = string, Optional extends boolean = false>
  extends Column<T, Optional> {
  primaryKey(): Column<T, true>;
  column(name: string): UuidColumn<T, Optional>;
}

export interface TimestampColumn<Optional extends boolean = false> extends Column<Date, Optional> {
  defaultNow(): TimestampColumn<true>;
  onUpdateNow(): TimestampColumn<Optional>;
  column(name: string): TimestampColumn<Optional>;
}

export type AnyColumn = Column<unknown, boolean>;

export type ColumnMap = Readonly<Record<string, AnyColumn>>;

export type TypeOf<C> = C extends Column<infer T, boolean> ? T : never;

/**
 * How a row is addressed: the type its own `id` column declared, or `string` when the entity is
 * keyed by something else (a composite key, or an unbranded uuid).
 *
 * This is where a brand used to die. `RowOf` and `Insertable` carry it through the derivation
 * without help, but `Repo.findById(id: string)` and `Table.update(id: string, …)` erased it at
 * the last hop — so `posts.update(someUserId, …)` type-checked and Postgres returned nothing.
 * `IdOf<Row>` collapses to `string` for every unbranded entity, so nothing that compiled before
 * stops compiling.
 */
export type IdOf<Row> = Row extends { readonly id: infer I extends string } ? I : string;

/** The row type a column set describes. This derivation is why the package exists. */
export type RowOf<C extends ColumnMap> = {
  readonly [K in keyof C]: TypeOf<C[K]>;
};

type DefaultedKeys<C extends ColumnMap> = {
  [K in keyof C]-?: C[K]['$optional'] extends true ? K : never;
}[keyof C];

/**
 * A `.nullable()` column is omissible too, and that is not a convenience — it is the difference
 * between declaring a fact and restating an absence. `nullable()` widens the type to `T | null`
 * without setting `$optional`, so every insert had to spell out `avatarKey: null, deletedAt: null`
 * for columns whose whole meaning is "there may be nothing here", and SQL was going to write NULL
 * either way. That is boilerplate the declaration already contains.
 *
 * Omitting it and passing `null` stay equivalent, deliberately: a caller building a row
 * programmatically should not have to strip keys to avoid a type error.
 */
type NullableKeys<C extends ColumnMap> = {
  [K in keyof C]-?: null extends TypeOf<C[K]> ? K : never;
}[keyof C];

/** Money is the one column whose write shape is wider than its row shape. */
type InputOf<T> = T extends MoneyValue ? MoneyInput : T;

/** What an insert must supply: every column that is neither defaulted nor nullable. */
export type Insertable<C extends ColumnMap> = {
  readonly [K in Exclude<keyof C, DefaultedKeys<C> | NullableKeys<C>>]: InputOf<TypeOf<C[K]>>;
} & {
  readonly [K in DefaultedKeys<C> | NullableKeys<C>]?: InputOf<TypeOf<C[K]>>;
};

/**
 * A patch or a filter: every property optional, **and every property allowed to be present and
 * `undefined`**.
 *
 * `Partial<Row>` cannot say the second half. Under `exactOptionalPropertyTypes` — which this repo
 * has on — `{ k?: T }` means "absent, or a `T`", so `{ postId: undefined }` is a type error, and
 * that is the ONE value every filtered write in this package is built to refuse:
 *
 * - `plan.ts`'s `namedColumns` drops `value !== undefined`, so `deleteWhere({ postId: undefined })`
 *   yields no predicate and throws `X_WRITE_UNFILTERED` rather than deleting the table. That
 *   refusal exists for exactly one caller — a variable that came back `undefined` — and
 *   `Partial<Row>` made the caller unable to spell it and the test unable to prove it.
 * - `updateWhere(filter, { createdAt: undefined })` is `X_PATCH_EMPTY`, one argument over.
 * - `bulk-write.ts`'s `owns()` is `Object.hasOwn`, so for a batch a present-`undefined` property
 *   IS a named column — the opposite reading, deliberately, and equally unspellable.
 *
 * A type that forbids the value its own runtime is written to catch is a type that documents
 * nothing: `bulk-write.test.ts` carried `as Partial<Item>` with the comment
 * "`exactOptionalPropertyTypes` is why it takes a cast to say", which is the defect written down.
 *
 * Money goes through `InputOf`, for the reason `Insertable` does: a patch is a WRITE, and money's
 * write shape is the wider one. `conflictKeyOf`'s own `cellKey` renders a `bigint` minor unit
 * (`${part}n`), so refusing one here would have been a type refusing a value one function down
 * spells out how to serialise. The row's own type stays in the union rather than being replaced by
 * `InputOf<Row[K]>`: a conditional type over an unresolved `Row` never reduces, so `Row` itself
 * stopped being assignable to its own patch and every internal caller reddened. Both spellings are
 * accepted here, which is the honest statement anyway — a patch may carry either.
 */
export type RowPatch<Row> = {
  readonly [K in keyof Row]?: Row[K] | InputOf<Row[K]> | undefined;
};

export interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly order?: 'asc' | 'desc';
  /** Partial index predicate — a soft-deleted row is excluded with this. */
  readonly where?: string;
}
