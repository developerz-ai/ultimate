// Typed factories derived from the entity registry. Rows come from the entity's own columns, so a
// new NOT NULL column breaks the factory at compile time instead of at the first insert — and the
// values are seeded, so two runs of the same suite produce byte-identical rows.
//
// Traits and associations are FactoryBot's two, and only its two: a trait is a named partial the
// caller composes, an association is a column whose value comes from another factory built with
// the SAME strategy — `build()` leaves the parent in memory, `create()` writes it.

import { seededRandom, seededUuid } from './determinism';
import { FactoryTraitUnknownError } from './errors';
import { persistRow } from './factory-persist';

export interface EntityLike {
  readonly kind: 'entity';
  readonly table: string;
  readonly columns: Readonly<Record<string, unknown>>;
}

/** The seeded generators a `defaults` or trait body draws from. Never `Math.random` directly. */
export interface FactoryIds {
  uuid(): string;
  number(): number;
}

/** A named partial. A function form gets the row's index and the same seeded generators. */
export type Trait<TRow> = Partial<TRow> | ((index: number, ids: FactoryIds) => Partial<TRow>);

export type TraitMap<TRow> = Readonly<Record<string, Trait<TRow>>>;

/**
 * A column filled from another factory. Opaque on purpose: `associate()` captures the parent
 * factory and the column to lift off it, so the map below stays exactly typed per column with no
 * variance escape hatch.
 */
export interface Association<TValue> {
  build(): TValue;
  create(): Promise<TValue>;
  /** Cascades from the child's `reset()`: a half-reset row is not the row the first block saw. */
  reset(): void;
}

export type AssociationMap<TRow> = { readonly [K in keyof TRow]?: Association<TRow[K]> };

/**
 * `associate(orgs, (org) => org.id)` — the parent is built with the strategy the child is built
 * with, which is the whole reason associations are not just another default: `create()` on a post
 * has to leave an org row behind it, and `build()` must not touch a database at all.
 */
export function associate<TParent extends object, TValue>(
  parent: Factory<TParent>,
  pick: (row: TParent) => TValue,
): Association<TValue> {
  return {
    build: () => pick(parent.build()),
    create: async () => pick(await parent.create()),
    reset: () => parent.reset(),
  };
}

export interface FactoryOptions<TRow, TTraits extends TraitMap<TRow> = TraitMap<TRow>> {
  /** Omitted means "derived from the table name" — see `seedFor`. */
  readonly seed?: number;
  /** Values for every column the entity requires; called once per built row. */
  defaults(index: number, ids: FactoryIds): TRow;
  readonly traits?: TTraits;
  /**
   * `NoInfer`, because `AssociationMap<TRow>` is homomorphic over `keyof TRow` and TypeScript
   * reverse-maps it into an inference candidate: a factory declaring `associations: { orgId }`
   * inferred `TRow = { orgId: string }` and silently dropped every other column from `build()`,
   * `Partial<TRow>` overrides and `Trait<TRow>`. Associations are a SUBSET of the columns by
   * construction, so they can never be a correct source for the row type — `defaults` is, and it
   * is the one member required to name every column.
   */
  readonly associations?: AssociationMap<NoInfer<TRow>>;
}

export interface Factory<TRow, TTrait extends string = string> {
  readonly table: string;
  /** The declared trait names, sorted — what a failure lists and what a test can assert on. */
  readonly traits: readonly TTrait[];
  build(over?: Partial<TRow>): TRow;
  buildMany(count: number, over?: Partial<TRow>): readonly TRow[];
  /** Build, resolve associations by creating their parents, and write through the persister. */
  create(over?: Partial<TRow>): Promise<TRow>;
  createMany(count: number, over?: Partial<TRow>): Promise<readonly TRow[]>;
  /** A view with those traits applied, sharing this factory's sequence so ids never repeat. */
  with(...traits: readonly TTrait[]): Factory<TRow, TTrait>;
  /** Restart the sequence so a second describe block sees the same ids as the first. */
  reset(): void;
}

/**
 * Two factories with the same seed emit the same uuids, so a default of `1` everywhere gave a user
 * and a post the same id — rows that only look related. FNV-1a over the table name keeps every
 * table on its own stream while staying a pure function of the schema, so the ids are still
 * identical run to run and machine to machine.
 */
export function seedFor(table: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < table.length; i += 1) {
    hash = Math.imul(hash ^ table.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash === 0 ? 1 : hash;
}

export function defineFactory<TRow extends object, TTraits extends TraitMap<TRow> = TraitMap<TRow>>(
  entity: EntityLike,
  options: FactoryOptions<TRow, TTraits>,
): Factory<TRow, Extract<keyof TTraits, string>> {
  type Name = Extract<keyof TTraits, string>;
  const seed = options.seed ?? seedFor(entity.table);
  const traits: TraitMap<TRow> = options.traits ?? {};
  const declared = Object.keys(traits).sort() as Name[];
  // Erased to one shape for iteration; the public `AssociationMap` already held each entry to its
  // own column's type, so the value at key K is an `Association<TRow[K]>` by construction.
  const links = Object.entries(
    (options.associations ?? {}) as Readonly<Record<string, Association<unknown>>>,
  );

  let uuid = seededUuid(seed);
  let random = seededRandom(seed);
  let index = 0;
  const ids: FactoryIds = {
    uuid: () => uuid(),
    number: () => Math.floor(random() * 1_000_000),
  };

  // `Object.hasOwn`, not `traits[name] === undefined`: the plain read walked the prototype chain,
  // so `f.with('toString')` was ACCEPTED and applied `Object.prototype.toString` — `overridesOf`
  // called it with no receiver, got `"[object Undefined]"` and spread a string, producing a row
  // with 18 numeric columns that `create()` then handed to `persistRow`. `f.with('constructor')`
  // was accepted the same way and applied nothing at all.
  const assertTrait = (name: string): string => {
    if (!Object.hasOwn(traits, name)) {
      throw new FactoryTraitUnknownError({ table: entity.table, trait: name, declared });
    }
    return name;
  };

  /**
   * Traits then the call's own overrides, resolved before any association runs: a column the
   * caller supplied must not also create a parent row nobody asked for.
   */
  const overridesOf = (
    applied: readonly string[],
    over: Partial<TRow>,
    i: number,
  ): Partial<TRow> => {
    let patch: Partial<TRow> = {};
    for (const name of applied) {
      const trait = traits[name];
      patch = { ...patch, ...(typeof trait === 'function' ? trait(i, ids) : trait) };
    }
    return { ...patch, ...over };
  };

  const buildRow = (applied: readonly string[], over: Partial<TRow>): TRow => {
    index += 1;
    const base = options.defaults(index, ids);
    const overrides = overridesOf(applied, over, index);
    const linked: Record<string, unknown> = {};
    for (const [column, link] of links) if (!(column in overrides)) linked[column] = link.build();
    return { ...base, ...(linked as Partial<TRow>), ...overrides };
  };

  const createRow = async (applied: readonly string[], over: Partial<TRow>): Promise<TRow> => {
    index += 1;
    const base = options.defaults(index, ids);
    const overrides = overridesOf(applied, over, index);
    const linked: Record<string, unknown> = {};
    // Sequential, not `Promise.all`: two parents built concurrently would interleave their draws
    // from the shared seeded generators and the run would stop being reproducible.
    for (const [column, link] of links) {
      if (!(column in overrides)) linked[column] = await link.create();
    }
    const row = { ...base, ...(linked as Partial<TRow>), ...overrides };
    await persistRow(entity.table, row);
    return row;
  };

  const view = (applied: readonly string[]): Factory<TRow, Name> => ({
    table: entity.table,
    traits: declared,
    build: (over = {}) => buildRow(applied, over),
    buildMany: (count, over = {}) => Array.from({ length: count }, () => buildRow(applied, over)),
    create: (over = {}) => createRow(applied, over),
    createMany: async (count, over = {}) => {
      const rows: TRow[] = [];
      for (let i = 0; i < count; i += 1) rows.push(await createRow(applied, over));
      return rows;
    },
    // Checked here rather than at build time: `with()` is the line that named the trait, and a
    // failure three calls later would point at a row instead of at the typo.
    with: (...names) => view([...applied, ...names.map(assertTrait)]),
    reset: () => {
      uuid = seededUuid(seed);
      random = seededRandom(seed);
      index = 0;
      // Without this a reset factory rebuilt its own columns identically and drew a fresh org id
      // for the association — one row that is half the row the first block saw, which is worse
      // than not resetting at all because only one column moves.
      for (const [, link] of links) link.reset();
    },
  });

  return view([]);
}
