// What `defineFactory` takes and what it returns, as types. The four strategies are FactoryBot's —
// `build`, `create`, `attributesFor` and the `…List` forms — and nothing else: one name per job.

import type {
  AttributesFor,
  Built,
  Created,
  EntityLike,
  FactoryContext,
  FactoryIds,
  FactoryOverrides,
  ForeignKeysOf,
  HasManyMap,
  None,
  SettledAttrs,
  TraitMap,
  WriteBound,
} from './factory-types';

export interface FactoryOptions<
  TAttrs extends object,
  TTraits,
  TTransient extends object,
  TBelongs,
  TMany,
  TRow extends object,
  E = EntityLike,
> {
  /** Omitted means "derived from the table name" — see `seedFor`. */
  readonly seed?: number;
  /**
   * Every column the factory owns; called once per row. `index` is the sequence. It must name each
   * `belongsTo` key, so a key that is not a column is a compile error HERE: a check written as a
   * constraint on `belongsTo` fixed the row type before this was read, and every row became `object`.
   * `Readonly<TAttrs>` is the slot that keeps an enum literal literal (`DefaultsBound`).
   */
  defaults(
    index: number,
    ids: FactoryIds,
    transient: TTransient,
  ): TAttrs & Readonly<TAttrs> & WriteBound<E> & Readonly<Record<ForeignKeysOf<TBelongs>, unknown>>;
  readonly traits?: TTraits;
  /** Attributes a call may pass that are never written: read by `defaults`, traits and callbacks. */
  readonly transient?: TTransient;
  readonly belongsTo?: TBelongs;
  readonly hasMany?: TMany;
  /**
   * After the row is assembled, before any write — both strategies. The row is `build()`'s own
   * type: a column holds its declared union, never the widened `SettledAttrs` one.
   */
  afterBuild?(
    row: NoInfer<SettledAttrs<TAttrs> & Partial<TRow>>,
    context: FactoryContext<TTransient>,
  ): void;
  /** After the row and its `hasMany` children are stored — `create()` only. */
  afterCreate?(
    row: NoInfer<Created<TRow, TMany>>,
    context: FactoryContext<TTransient>,
  ): void | Promise<void>;
}

/**
 * What `extend()` adds: more defaults, traits, transients, callbacks — and `hasMany`, which is
 * where a two-way association closes its cycle: `posts` is declared, `comments` belongs to it, and
 * `posts.extend({ hasMany: { comments: hasMany(commentFactory, 'postId') } })` comes after both.
 */
export interface FactoryExtension<
  TAttrs extends object,
  TTraits,
  TTransient extends object,
  TRow extends object,
  TMany,
  TMoreMany = None,
> {
  defaults?(index: number, ids: FactoryIds, transient: TTransient): Partial<TAttrs & TRow>;
  readonly traits?: TTraits;
  readonly transient?: Partial<TTransient>;
  readonly hasMany?: TMoreMany;
  afterBuild?(row: TAttrs & Partial<TRow>, context: FactoryContext<TTransient>): void;
  afterCreate?(
    row: Created<TRow, TMany & TMoreMany>,
    context: FactoryContext<TTransient>,
  ): void | Promise<void>;
}

export interface Factory<
  TAttrs extends object,
  TTrait extends string = string,
  TRow extends object = TAttrs,
  TTransient extends object = None,
  TBelongs = None,
  TMany = None,
> {
  readonly entity: EntityLike;
  readonly table: string;
  /** The declared trait names, sorted — what a failure lists and what a test can assert on. */
  readonly traits: readonly TTrait[];
  /** In memory: parents built, never written. No database is reached. */
  build(
    over?: FactoryOverrides<TAttrs & TRow, TTransient, TBelongs, TMany>,
  ): Built<TAttrs & Partial<TRow>, TMany>;
  buildList(
    count: number,
    over?: FactoryOverrides<TAttrs & TRow, TTransient, TBelongs, TMany>,
  ): readonly Built<TAttrs & Partial<TRow>, TMany>[];
  /** Parents created first, the row written through the persister, children after it: STORED rows. */
  create(
    over?: FactoryOverrides<TAttrs & TRow, TTransient, TBelongs, TMany>,
  ): Promise<Created<TRow, TMany>>;
  createList(
    count: number,
    over?: FactoryOverrides<TAttrs & TRow, TTransient, TBelongs, TMany>,
  ): Promise<readonly Created<TRow, TMany>[]>;
  /** An action's input: no primary key, no parent key, no transient, nothing built or written. */
  attributesFor(
    over?: Partial<TAttrs & TRow> & Partial<TTransient>,
  ): AttributesFor<TAttrs, TBelongs>;
  /** A view with those traits applied, sharing this factory's sequence so ids never repeat. */
  with(...traits: readonly TTrait[]): Factory<TAttrs, TTrait, TRow, TTransient, TBelongs, TMany>;
  /** A child factory — same table, same sequence, its defaults over these, its callbacks after. */
  extend<
    TMoreTraits extends TraitMap<TAttrs & TRow, TTransient> = None,
    TMoreMany extends HasManyMap = None,
  >(
    extension: FactoryExtension<TAttrs, TMoreTraits, TTransient, TRow, TMany, TMoreMany>,
  ): Factory<
    TAttrs,
    TTrait | Extract<keyof TMoreTraits, string>,
    TRow,
    TTransient,
    TBelongs,
    TMany & TMoreMany
  >;
  /** Restart the sequence so a second describe block sees the same ids as the first. */
  reset(): void;
}

/** Any factory, its types erased: what `lintFactories` and `factorySeed` hold. */
export type AnyFactory = Factory<object, string, object, object, unknown, unknown>;
