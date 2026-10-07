// Compile-time pins for the two type positions this package has already regressed in. Source, not
// a `.test.ts`, on purpose: `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a
// test file and a type-level assertion written there can never fail. Everything below is erased —
// the module emits nothing — and a regression is a build error, which is the only kind of
// enforcement this repo counts (axiom 3).

import type { Id } from '@ultimat3/core';
import type { Schema, MoneyValue as SchemaMoneyValue } from '@ultimat3/schema';
import type { uuid } from './columns';
import type { EntitySet } from './database';
import type { Entity, EntityCore, EntityInit } from './entity';
import type { ColumnExpr, InvariantColumns } from './expr';
import type { Invariant, InvariantDef } from './invariants';
import type { ReadBuilder, Table } from './query';
import type { Repo } from './repo';
import type {
  AnyColumn,
  IdOf,
  Insertable,
  MoneyInput,
  MoneyValue,
  RowOf,
  SealedColumn,
  TextColumn,
  WireRow,
} from './types';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

/**
 * Shaped like a declared column set; only its keys and its derived row take part. A type alias,
 * not an interface: only an alias gets the implicit index signature `ColumnMap` asks for.
 */
type PinColumns = {
  readonly title: AnyColumn;
  readonly price: AnyColumn;
};

type PinRow = RowOf<PinColumns>;

/** Ambient: a type query needs a value to name, and an ambient declaration emits nothing. */
declare const pinned: InvariantColumns<PinColumns>;

/**
 * The defect: `InvariantColumns` was `{ readonly [column: string]: ColumnExpr }`, so under
 * `noUncheckedIndexedAccess` every `c.title` was `ColumnExpr | undefined` and every generated
 * entity needed a `!`. Written as a property access rather than an indexed-access type, because
 * that is the position the flag widens.
 */
export type PinColumnIsNotOptional = Assert<undefined extends typeof pinned.title ? false : true>;

export type PinColumnIsAColumnExpr = Assert<
  [typeof pinned.title] extends [ColumnExpr] ? true : false
>;

/** An index signature would make every string a key, so a typo would type-check. */
export type PinUnknownColumnIsNotAKey = Assert<
  'titel' extends keyof InvariantColumns<PinColumns> ? false : true
>;

/** `unique()` and `satisfies()` name columns as strings, so they need the same protection. */
export type PinHelpersTakeDeclaredColumns = Assert<
  readonly 'titel'[] extends Parameters<InvariantColumns<PinColumns>['unique']>[0] ? false : true
>;

/**
 * `invariants` is one callback over the whole list, never an array of `(c) => …` builders: a
 * per-element builder is a call TypeScript checks before `C` is fixed, so `C` fell back to its
 * constraint and the mapped type above never reached the author.
 */
export type PinInvariantsIsOneCallback = Assert<
  EntityInit<PinColumns>['invariants'] extends
    | ((columns: InvariantColumns<PinColumns>) => readonly InvariantDef[])
    | undefined
    ? true
    : false
>;

/**
 * `Invariant<T>.holds` is a method, not a `readonly holds: (row: T) => boolean` property. A
 * function-typed property is checked contravariantly, which made `Invariant<PinRow>` unassignable
 * to `Invariant<unknown>`, `Entity<PinRow, C>` unassignable to `EntityCore`, and so every
 * `database({ … })` call degrade to `Table<unknown>` — one position, 36 cascading errors.
 */
export type PinInvariantIsBivariant = Assert<
  [Invariant<PinRow>] extends [Invariant<unknown>] ? true : false
>;

export type PinEntityIsAnEntityCore = Assert<
  [Entity<PinRow, PinColumns>] extends [EntityCore] ? true : false
>;

export type PinEntityMapIsAnEntitySet = Assert<
  [{ readonly post: Entity<PinRow, PinColumns> }] extends [EntitySet] ? true : false
>;

// --- Insertable: a nullable column is omissible ------------------------------
// `nullable()` widens the type to `T | null` without setting `$optional`, so before this pin every
// insert had to spell out `avatarKey: null, deletedAt: null` — restating an absence the column
// declaration already carries, for values SQL was going to write as NULL either way. The demo's
// seed could not compile without that padding, which is precisely the boilerplate this framework
// exists to delete.

declare const nullableColumn: import('./types').Column<string | null, false>;
declare const requiredColumn: import('./types').Column<string, false>;

type InsertPinColumns = {
  readonly required: typeof requiredColumn;
  readonly optionalByNull: typeof nullableColumn;
};

type InsertPin = import('./types').Insertable<InsertPinColumns>;

/** The nullable column may be omitted entirely… */
type _NullableIsOmissible = Assert<{ required: 'x' } extends InsertPin ? true : false>;

/** …and passing `null` explicitly stays legal, so a programmatic caller need not strip keys. */
type _NullableStillAccepted = Assert<
  { required: 'x'; optionalByNull: null } extends InsertPin ? true : false
>;

/** A non-nullable column with no default is still required — the pin must not over-relax. */
type _RequiredStaysRequired = Assert<{ optionalByNull: null } extends InsertPin ? false : true>;

// --- The bulk write path keeps every narrowing the single-row one has ---------
// `insertAll`/`upsertAll` are `insert` in bulk, and a bulk signature is exactly where one quietly
// widens: `readonly Row[]` instead of `readonly Insertable<C>[]` would make every batch spell out
// the defaults `insert` fills for one row, and a `readonly string[]` conflict target would push a
// typo the single-row path never had to the runtime guard.

type InsertPinTable = Table<RowOf<InsertPinColumns>, InsertPinColumns>;
type ConflictTarget = Parameters<InsertPinTable['upsertAll']>[1]['onConflict'];

/** A batch is `Insertable`, so a nullable column stays omissible a hundred rows at a time. */
type _InsertAllTakesInsertables = Assert<
  readonly { required: 'x' }[] extends Parameters<InsertPinTable['insertAll']>[0] ? true : false
>;

/** What comes back is the stored row, never the insertable the caller handed in. */
type _InsertAllResolvesWithRows = Assert<
  [Awaited<ReturnType<InsertPinTable['insertAll']>>] extends [readonly RowOf<InsertPinColumns>[]]
    ? true
    : false
>;

type _ConflictTargetTakesADeclaredColumn = Assert<
  readonly 'required'[] extends ConflictTarget ? true : false
>;

/** The narrowing that matters: a misspelled conflict target is a compile error, not a rejection. */
type _ConflictTargetRejectsATypo = Assert<
  readonly 'requiredd'[] extends ConflictTarget ? false : true
>;

// --- A branded id survives the whole type chain ------------------------------
// `uuid<PostId>()` is where the brand is declared, and every hop after it has to carry it. The
// derivation (`TypeOf`, `RowOf`, `Insertable`) always did; the BUILDER hard-coded `Column<string>`
// so there was nothing to carry, and `Repo`/`Table` then took `id: string`, which is where the
// last of it went. Both halves are pinned, because fixing either one alone still lets
// `posts.update(someUserId, …)` compile.

type PostId = Id<'post'>;
type UserId = Id<'user'>;

/** The builder's own output, not a hand-written `Column<PostId, true>`. */
type BrandedKey = ReturnType<ReturnType<typeof uuid<PostId>>['primaryKey']>;

type BrandColumns = {
  readonly id: BrandedKey;
  readonly authorId: ReturnType<typeof uuid<UserId>>;
  readonly title: typeof requiredColumn;
};

type BrandRow = RowOf<BrandColumns>;

type _BrandSurvivesTheRow = Assert<[BrandRow['id']] extends [PostId] ? true : false>;

/** The half that matters: a plain string is no longer good enough to be a post id. */
type _RowIdIsNotAPlainString = Assert<[string] extends [BrandRow['id']] ? false : true>;

/** Two entities' ids do not mix, which is the whole reason to declare one. */
type _BrandsDoNotMix = Assert<[BrandRow['authorId']] extends [PostId] ? false : true>;

/** The write path too — an insert that names the wrong entity's id is a compile error. */
type _BrandSurvivesTheInsert = Assert<
  [Insertable<BrandColumns>['authorId']] extends [UserId] ? true : false
>;

type _InsertRejectsAnotherBrand = Assert<
  [PostId] extends [Insertable<BrandColumns>['authorId']] ? false : true
>;

/** `Repo` was the last hop that erased it: `findById(id: string)` accepted any entity's id. */
type _FindByIdTakesTheBrand = Assert<
  [Parameters<Repo<BrandRow>['findById']>[0]] extends [PostId] ? true : false
>;

type _FindByIdRejectsAnotherBrand = Assert<
  [UserId] extends [Parameters<Repo<BrandRow>['findById']>[0]] ? false : true
>;

/**
 * `UpsertArgs<T>.onConflict` is `readonly (keyof T & string)[]`, which is `readonly never[]` at
 * `T = unknown` — so a typed repository must still satisfy the row-agnostic one `RelatedTable.repo`
 * and the generated admin are written against, or narrowing the target breaks the preload seam.
 */
type _TypedRepoIsARowAgnosticRepo = Assert<[Repo<BrandRow>] extends [Repo<unknown>] ? true : false>;

type _TableUpdateTakesTheBrand = Assert<
  [Parameters<Table<BrandRow>['update']>[0]] extends [PostId] ? true : false
>;

type _TableDeleteRejectsAnotherBrand = Assert<
  [UserId] extends [Parameters<Table<BrandRow>['delete']>[0]] ? false : true
>;

/**
 * …and an unbranded entity is addressed exactly as it was. `IdOf` collapsing to `string` for
 * every row that declared no brand is what makes this additive rather than a major version.
 */
type _UnbrandedIdStaysAString = Assert<
  [string] extends [IdOf<{ readonly id: string }>] ? true : false
>;

// --- The batch iteration stays consumable both ways --------------------------
// `inBatches()` is the one read that hands back a resource instead of a value, and both ways of
// consuming it are language features rather than methods a call site would obviously miss:
// `for await` needs `[Symbol.asyncIterator]`, `await using` needs `[Symbol.asyncDispose]`. Losing
// either is a silent regression — every existing call keeps compiling, and only the loop that was
// supposed to stop reading stops stopping.

type BatchPin = ReturnType<Table<BrandRow>['inBatches']>;

type _BatchIterates = Assert<
  [BatchPin] extends [AsyncIterable<readonly BrandRow[]>] ? true : false
>;

type _BatchDisposes = Assert<[BatchPin] extends [AsyncDisposable] ? true : false>;

/** Batches, never rows: yielding one row at a time is the loop this call exists to replace. */
type _BatchYieldsBatches = Assert<[BatchPin] extends [AsyncIterable<BrandRow>] ? false : true>;

type _RowAgnosticIdStaysAString = Assert<[string] extends [IdOf<unknown>] ? true : false>;

// --- Money is one declaration, and the wide half is the write half -----------
// `MoneyValue` was a third structural restatement of `Money` whose `minor` was a `bigint`, so a
// row this package decoded satisfied neither `t.money` nor `JSON.stringify` — the shape the whole
// framework passes around was not the shape its own driver produced. It is now an alias of
// `@ultimat3/schema`'s declaration, which is also what `@ultimat3/money`'s `Money` is; these pins
// are what stops the next edit from re-declaring it here and re-opening the same gap.

/**
 * Identity, not mutual assignability: `extends` ignores `readonly`, so the weaker test would pass
 * against a mutable restatement — which is exactly the drift being pinned against.
 */
type Identical<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

type _MoneyValueIsSchemasDeclaration = Assert<Identical<MoneyValue, SchemaMoneyValue>>;

/** The value type is a `number`. A `bigint` here is the regression, not a widening. */
type _MoneyMinorIsANumber = Assert<[MoneyValue['minor']] extends [number] ? true : false>;

// The shape is pinned as independent properties rather than as one literal snapshot of the whole
// interface. The snapshot said the same thing, but every additive change had to be hand-edited
// past it — and a pin the next reader learns to hand-edit reflexively has stopped being a check.
// Only the key set moves when a field is added, which is the one place that decision belongs.

/** No field but these three, ever: a fourth is a shape nobody declared. */
type _MoneyHasNoOtherField = Assert<
  [keyof MoneyValue] extends ['minor' | 'currency' | 'scale'] ? true : false
>;

/** …and none of the three may go — the pin must not pass by the type shrinking instead. */
type _MoneyHasEveryField = Assert<
  ['minor' | 'currency' | 'scale'] extends [keyof MoneyValue] ? true : false
>;

// Immutable, enforced, field by field: a mutable `minor` is a rounding bug with a place to hide.
// `Pick` carries `readonly` and optionality through, so each of these is exact about one field
// and says nothing about the others.

type _MoneyMinorIsAReadonlyNumber = Assert<
  Identical<Pick<MoneyValue, 'minor'>, { readonly minor: number }>
>;

type _MoneyCurrencyIsAReadonlyString = Assert<
  Identical<Pick<MoneyValue, 'currency'>, { readonly currency: string }>
>;

/**
 * `scale` is the decimal exponent `minor` counts in — `{ minor: 2, currency: 'USD', scale: 6 }` is
 * $0.000002. Optional, and pinned optional, because a cents-only `Money` could not name a
 * sub-cent amount at all: the AI cost path rounded a $0.00016 call up to a whole cent, 62x, and
 * the alternative to this field was a second money type.
 */
type _MoneyScaleIsAReadonlyOptionalNumber = Assert<
  Identical<Pick<MoneyValue, 'scale'>, { readonly scale?: number }>
>;

/**
 * The additive half, and the pin that decides the semver: a value carrying no scale is still a
 * `MoneyValue`, meaning the currency's own minor unit. Every amount already stored, serialized
 * and asserted against in every app is that shape — so the day this fails, the change that made
 * it fail is a breaking one and needs a major, not a fix here.
 */
type _MoneyWithoutAScaleIsStillMoney = Assert<
  { readonly minor: number; readonly currency: string } extends MoneyValue ? true : false
>;

/**
 * A writer may still hand a `bigint` — that is the additive half, and it is what lets a minor unit
 * read straight off a `bigint` column reach an insert without a conversion at the call site.
 */
type _MoneyInputTakesABigInt = Assert<
  [{ readonly minor: bigint; readonly currency: string }] extends [MoneyInput] ? true : false
>;

/** And a row value is always a legal input: read a row, write it back. */
type _MoneyValueIsMoneyInput = Assert<[MoneyValue] extends [MoneyInput] ? true : false>;

/** A row with the one column whose write type is wider than its row type, and nothing else. */
type PinMoneyRow = { readonly id: string; readonly price: MoneyValue };

type PinWideMoneyRow = {
  readonly id: string;
  readonly price: { readonly minor: bigint; readonly currency: string };
};

/**
 * The pin the two above needed all along. `MoneyInput` declares the widening and could never
 * enforce it end to end: `Repo.insert` took the ROW type, so the one call an app makes refused the
 * value those lines call legal — a compile error at `postgresRepo().insert(...)`, which is exported
 * and therefore public API, while both drivers narrowed it correctly at runtime. Pinned at `Repo`
 * rather than at `RowWrite`, because a mapped type is only worth having where it is spent.
 */
type _RepoInsertTakesABigIntMinor = Assert<
  [PinWideMoneyRow] extends [Parameters<Repo<PinMoneyRow>['insert']>[0]] ? true : false
>;

/** Every whole-row write, not just the single one — three entry points, one shape. */
type _RepoBatchWritesTakeABigIntMinor = Assert<
  [readonly PinWideMoneyRow[]] extends [Parameters<Repo<PinMoneyRow>['insertAll']>[0]] &
    [Parameters<Repo<PinMoneyRow>['upsertAll']>[0]]
    ? true
    : false
>;

/**
 * And the half that must NOT widen: what a repository answers with is the row type. `minor` stays
 * a `number` because money crosses every wire this framework projects and `JSON.stringify` refuses
 * a `bigint` — the widening is the caller's spelling, never the row's.
 */
type _RepoAnswersTheValueType = Assert<
  [Awaited<ReturnType<Repo<PinMoneyRow>['insert']>>] extends [PinMoneyRow] ? true : false
>;

// --- Sealed columns (plan 101, slice 03) ---------------------------------------------------------
// The row keeps `string`; the wire schema loses the column; a predicate naming it does not compile.

declare const sealedPin: Entity<RowOf<SealedPinColumns>, SealedPinColumns>;
type SealedPinColumns = {
  readonly id: ReturnType<typeof uuid>;
  readonly label: TextColumn;
  readonly password: SealedColumn<string, false, false>;
  readonly email: SealedColumn<string, false, true>;
};
type SealedPinRow = RowOf<SealedPinColumns>;
declare const sealedTable: Table<SealedPinRow, SealedPinColumns>;

/** The server row is the whole row, plaintext included. */
export type _SealedRowKeepsTheColumn = Assert<
  SealedPinRow['password'] extends string ? true : false
>;

/** `$schema` parses to the row WITHOUT its sealed columns — what an `output` sends. */
type SealedWire = WireRow<SealedPinRow, SealedPinColumns>;
export type _SealedWireDropsBoth = Assert<
  'password' extends keyof SealedWire ? false : 'email' extends keyof SealedWire ? false : true
>;
export type _SealedWireKeepsTheRest = Assert<'label' extends keyof SealedWire ? true : false>;
export type _SealedSchemaIsTheWireRow = Assert<
  (typeof sealedPin)['$schema'] extends Schema<unknown, SealedWire> ? true : false
>;
/** …and an entity with no sealed column keeps `Row` itself, not a mapped copy. */
export type _UnsealedWireIsTheRow = Assert<
  WireRow<PinRow, PinColumns> extends PinRow
    ? PinRow extends WireRow<PinRow, PinColumns>
      ? true
      : false
    : false
>;

/** A sealed entity is still an `EntityCore`, so `database()` and every driver take it. */
export type _SealedEntityIsACore = Assert<
  typeof sealedPin extends EntityCore<SealedPinRow, SealedPinColumns> ? true : false
>;
export type _SealedEntityIsInASet = Assert<
  { readonly x: typeof sealedPin } extends EntitySet ? true : false
>;

type WhereFilter = Parameters<(typeof sealedTable)['where']>[0];
/** An opaque column is absent from the filter; a lookup column and a plain one are present. */
export type _OpaqueIsNotFilterable = Assert<'password' extends keyof WhereFilter ? false : true>;
export type _LookupIsFilterable = Assert<'email' extends keyof WhereFilter ? true : false>;
export type _PlainIsFilterable = Assert<'label' extends keyof WhereFilter ? true : false>;

type AndWhereColumn = Parameters<(typeof sealedTable)['andWhere']>[0];
export type _OpaqueIsNotAPredicate = Assert<'password' extends AndWhereColumn ? false : true>;
export type _LookupIsAPredicate = Assert<'email' extends AndWhereColumn ? true : false>;
/** …but a NULL test names any column: presence is not sealed. The overload is the first one. */
declare const nullTested: ReturnType<typeof nullTest>;
declare function nullTest(): ReturnType<(typeof sealedTable)['andWhere']>;
export type _NullTestTakesAnOpaqueColumn = Assert<
  (typeof sealedTable)['andWhere'] extends (column: 'password', op: 'is-null') => typeof nullTested
    ? true
    : false
>;

type OrderColumn = Parameters<(typeof sealedTable)['orderBy']>[0];
/** Neither kind orders: ciphertext has no order worth asking for. */
export type _SealedDoesNotOrder = Assert<
  'password' extends OrderColumn ? false : 'email' extends OrderColumn ? false : true
>;
export type _PlainOrders = Assert<'label' extends OrderColumn ? true : false>;

/** `.sealed()` is `text()`'s: no other builder has it, so a sealed number does not compile. */
export type _OnlyTextSeals = Assert<
  'sealed' extends keyof TextColumn
    ? 'sealed' extends keyof ReturnType<typeof uuid>
      ? false
      : true
    : false
>;
/** It survives the links that may precede it, and keeps its marker across the ones that follow. */
export type _SealedAfterNullable = Assert<
  ReturnType<TextColumn['nullable']> extends { sealed: unknown } ? true : false
>;
export type _MarkerSurvivesNullable = Assert<
  ReturnType<SealedColumn<string, false, true>['nullable']>['$sealed'] extends 'lookup'
    ? true
    : false
>;

/**
 * A sealed table is still a `ReadBuilder<Row>`: `backfill({ source })`, `preload` and every other
 * consumer that names the chain without the columns takes it. The refusal is in the PARAMETERS,
 * which a method compares bivariantly, so the narrower chain is assignable to the wider one.
 */
export type _SealedTableIsAReadBuilder = Assert<
  typeof sealedTable extends ReadBuilder<SealedPinRow> ? true : false
>;

/**
 * Entity exports no `Page` (owner decision O-12, 25.0.0): `@ultimat3/core`'s is the ONE page
 * shape, and `findMany` answers it — import it from core (or `@ultimat3/query`, which re-exports
 * it). A second spelling here is a second door to one name; re-exporting it from this barrel
 * makes this directive unused, which is the build error.
 */
// @ts-expect-error — `Page` is not an export of `@ultimat3/entity`.
export type _EntityExportsNoPage = import('./index').Page<unknown>;

/**
 * `findMany` answers core's `Page`, both halves of the union: a repo page whose `nextCursor` could
 * be set on the last page (entity's 24.x `Page` had no `hasMore` at all) fails here.
 */
export type _FindManyAnswersCorePage = Assert<
  [Awaited<ReturnType<Repo<{ id: string }>['findMany']>>] extends [
    import('@ultimat3/core').Page<{ id: string }>,
  ]
    ? [import('@ultimat3/core').Page<{ id: string }>] extends [
        Awaited<ReturnType<Repo<{ id: string }>['findMany']>>,
      ]
      ? true
      : false
    : false
>;
