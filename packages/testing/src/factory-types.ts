// The factory vocabulary as types: what a factory is declared with, what each strategy hands back,
// and what an override may name. Kept apart from the runtime so `factories.ts` holds one job — the
// row pipeline — and a caller reading the contract reads it here.

import type { ColumnMap, Insertable } from '@ultimat3/entity';

/**
 * The members of `entity()`'s value a factory reads, structurally: `@ultimat3/entity` is a
 * dynamic-only dependency of this barrel. `$table` is the PHYSICAL table. The optional members are
 * what a real entity adds — the default persister, tenancy and `references()` need them, a
 * hand-built lookalike in a unit test may leave them out.
 */
export interface EntityLike {
  readonly $table: string;
  readonly $columns: Readonly<Record<string, unknown>>;
  readonly $primaryKey?: readonly string[];
  readonly $tenantColumn?: string | null;
  $references?(): readonly { readonly property: string; readonly targetProperty: string }[];
  $parse?(value: unknown): unknown;
}

/** The seeded generators a `defaults` or trait body draws from. Never `Math.random` directly. */
export interface FactoryIds {
  uuid(): string;
  number(): number;
}

/** No members: the default for every optional map a factory declares. */
export type None = Record<never, never>;

/** What every body and callback of one row sees. `index` IS the sequence: 1, 2, 3 … per factory. */
export interface FactoryContext<TTransient extends object = None> {
  readonly index: number;
  readonly ids: FactoryIds;
  /** The declared transient defaults, overridden by the call. Never written to the row. */
  readonly transient: TTransient;
}

/** A named partial. A function form gets the row's index, the seeded generators and the transients. */
export type Trait<TRow, TTransient extends object = None> =
  | Partial<TRow>
  | ((index: number, ids: FactoryIds, transient: TTransient) => Partial<TRow>);

export type TraitMap<TRow, TTransient extends object = None> = Readonly<
  Record<string, Trait<TRow, TTransient>>
>;

/**
 * The structural face of any factory, as an association holds it. Method syntax on purpose: a
 * factory's `build(over?: Overrides<…>)` is assignable here only through method bivariance.
 */
export interface FactoryLike<TBuilt extends object = object, TRow extends object = object> {
  readonly entity: EntityLike;
  build(over?: object): TBuilt;
  create(over?: object): Promise<TRow>;
  reset(): void;
}

/** `belongsTo(orgs, 'orgId')`: the parent built with the strategy the child is built with. */
export interface BelongsTo<TBuilt extends object, TRow extends object, TKey extends string> {
  readonly kind: 'belongsTo';
  readonly parent: FactoryLike<TBuilt, TRow>;
  readonly foreignKey: TKey;
  /** The parent's column the key holds. Unset: the child entity's `references()`, else `id`. */
  readonly references: string | undefined;
}

/** `hasMany(comments, 'postId')`: children written AFTER the parent, the key set from it. */
export interface HasMany<TBuilt extends object, TRow extends object, TKey extends string> {
  readonly kind: 'hasMany';
  readonly child: FactoryLike<TBuilt, TRow>;
  readonly foreignKey: TKey;
  readonly references: string | undefined;
  /** Children made when the call names none. Default 0. */
  readonly count: number;
}

// `object`, not `unknown`: a `FactoryLike<TBuilt>` is invariant in nothing that matters here, and
// the map's job is only to say "every value is an association"; each one's own type is kept.
export type BelongsToMap<TKey extends string = string> = Readonly<
  Record<string, BelongsTo<object, object, TKey>>
>;
export type HasManyMap = Readonly<Record<string, HasMany<object, object, string>>>;

type ParentValue<B> = B extends BelongsTo<infer TBuilt, infer TRow, string> ? TBuilt | TRow : never;
type ManyValue<H> =
  H extends HasMany<infer TBuilt, object, string> ? number | readonly Partial<TBuilt>[] : never;
type ManyBuilt<H> = H extends HasMany<infer TBuilt, object, string> ? TBuilt : never;
type ManyStored<H> = H extends HasMany<object, infer TRow, string> ? TRow : never;
export type ForeignKeysOf<TBelongs> = {
  [K in keyof TBelongs]: TBelongs[K] extends BelongsTo<object, object, infer F> ? F : never;
}[keyof TBelongs];

/**
 * One call's overrides: columns, transients, a parent row per `belongsTo` name (`{ org: row }`,
 * reused rather than made), and per `hasMany` name a count or one override per child.
 */
export type FactoryOverrides<TAttrs, TTransient, TBelongs, TMany> = Partial<TAttrs> &
  Partial<TTransient> & { readonly [K in keyof TBelongs]?: ParentValue<TBelongs[K]> } & {
    readonly [K in keyof TMany]?: ManyValue<TMany[K]>;
  };

/**
 * `build()`'s answer: the attributes, each `hasMany` name holding the children built with them —
 * as a NON-enumerable property, so the row itself is only its columns.
 */
export type Built<TAttrs, TMany> = TAttrs & {
  readonly [K in keyof TMany]: readonly ManyBuilt<TMany[K]>[];
};

/** `create()`'s answer: the row AS STORED, each `hasMany` name (non-enumerable) its stored children. */
export type Created<TRow, TMany> = TRow & {
  readonly [K in keyof TMany]: readonly ManyStored<TMany[K]>[];
};

/**
 * `attributesFor()`'s answer — an input, not a row: no parent key. The primary key is dropped at
 * runtime (`$primaryKey`); the type omits `id`, the one key name `entity()` gives a type to see.
 */
export type AttributesFor<TAttrs, TBelongs> = Omit<TAttrs, ForeignKeysOf<TBelongs> | 'id'>;

/** The stored row of a real `entity()` (`$row`); a lookalike's is what its factory builds. */
export type StoredOf<E, TAttrs> = E extends { readonly $row: infer R extends object } ? R : TAttrs;

/**
 * What `defaults` may name for an `entity()`: its columns, each as its write shape. A column the
 * entity does not declare, or a value of the wrong kind, is a compile error at the factory.
 */
export type WriteBound<E> = E extends { readonly $columns: infer C extends ColumnMap }
  ? Partial<Insertable<C>>
  : object;
