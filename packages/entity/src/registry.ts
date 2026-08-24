// The entity registry. Every `entity()` call registers here, which is what makes
// `x.manifest.json`, the admin dashboard generator and the migration emitter able to see the
// whole domain without importing it — and what makes a duplicate name a build error rather
// than a silent last-one-wins.

import type { IndexMethod } from '@ultimat3/db';
import { entityDuplicate } from './errors';
import type { InvariantKind } from './invariants';
import type { OnDelete } from './types';

export interface ColumnDescription {
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
   * The `references()` rule, `null` when the key declared none. Beside `references` rather than
   * inside it because that field is a flat `"<table>.<column>"` string with no room for it, and
   * `@ultimat3/db` is tier 1: it cannot import this package, so a rule that is not on this
   * projection reaches no `alter table` at all. It reached none until 3.0.
   */
  readonly onDelete: OnDelete | null;
}

/**
 * One `references()`, resolved: both ends, both names. `ColumnDescription.references` renders
 * this as `"<table>.<column>"` for the migration generator (tier 1, which cannot import this
 * package) and the manifest — physical names, which is their whole vocabulary. A traversal needs
 * the row *properties* too, so it reads the record; the string is written, never parsed back.
 */
export interface ReferenceDescription {
  /** Property key on the declaring row — what a JS caller reads and a preload collects. */
  readonly property: string;
  /** Physical column on the declaring table — what SQL names. */
  readonly column: string;
  /** The key accepts null, so a target that resolves to nothing is data, not a broken key. */
  readonly nullable: boolean;
  /** The entity referenced. Not necessarily registered — an entity may point outside a set. */
  readonly targetEntity: string;
  readonly targetProperty: string;
  readonly targetColumn: string;
  /** What the database does to this row when the target goes. `null` is Postgres' `no action`. */
  readonly onDelete: OnDelete | null;
}

export interface InvariantDescription {
  readonly name: string;
  readonly kind: InvariantKind;
  readonly message: string;
  /** `null` for an `assert`: a JS predicate the database was never told about. */
  readonly sql: string | null;
  readonly where: string | null;
}

/**
 * An index as the migration generator has to emit it. The columns are carried, never recovered
 * from `name`: `<table>_<a>_<b>_idx` is one string for two columns, and the convention that built
 * it cannot be run backwards — `posts_org_id_created_at_idx` reads as the single column
 * `"org_id_created_at"`, which is a `42703` at apply time. `where` and `order` are here for the
 * same reason: a partial index emitted as a total one refuses rows the entity allows.
 */
export interface IndexDescription {
  readonly name: string;
  /** Physical columns, in index order. Always at least one. */
  readonly columns: readonly string[];
  readonly unique: boolean;
  /** Partial index predicate as SQL, `null` when the index covers every row. */
  readonly where: string | null;
  /** `null` is Postgres' own default (`asc`), never written out. */
  readonly order: 'asc' | 'desc' | null;
  /**
   * The access method, `undefined` for the `btree` every index was before this existed. Absent
   * rather than `null`, matching `IndexDescriptionLike.using` in `@ultimat3/db`: a snapshot that
   * predates the field and an index that declares nothing read the same, so nothing regenerates.
   */
  readonly using?: IndexMethod | undefined;
}

export interface EntityDescription {
  readonly name: string;
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnDescription[];
  readonly invariants: readonly InvariantDescription[];
  readonly indexes: readonly IndexDescription[];
  readonly tags: readonly string[];
  readonly cacheTag: string;
  readonly softDelete: boolean;
  readonly orgScoped: boolean;
}

export interface RegistryEntry {
  readonly name: string;
  readonly tableName: string;
  describe(): EntityDescription;
  /**
   * The foreign keys this entity declares, resolved. This is how a relation reaches query time:
   * a method and not a field because a `references()` thunk may point at an entity declared
   * later in an import cycle, so resolving at registration would read a half-evaluated module.
   */
  references(): readonly ReferenceDescription[];
}

const entities = new Map<string, RegistryEntry>();
let generation = 0;

export const registerEntity = <E extends RegistryEntry>(entry: E): E => {
  const existing = entities.get(entry.name);
  if (existing !== undefined && existing !== entry) {
    throw entityDuplicate(entry.name, existing.tableName);
  }
  entities.set(entry.name, entry);
  generation += 1;
  return entry;
};

export const getEntity = (name: string): RegistryEntry | undefined => entities.get(name);

export const entityNames = (): readonly string[] => [...entities.keys()].sort();

/**
 * Bumped by every mutation. A projection of the WHOLE registry — the relation map — caches
 * against it, so a module imported late registers one more entity and invalidates that cache
 * instead of being missed by it.
 */
export const registryGeneration = (): number => generation;

/** Deterministic order: every projection of the registry is a build input and must diff cleanly. */
export const registeredEntities = (): readonly RegistryEntry[] =>
  entityNames().map((name) => {
    const entry = entities.get(name);
    if (entry === undefined) throw entityDuplicate(name, 'unknown');
    return entry;
  });

export const describeEntities = (): readonly EntityDescription[] =>
  registeredEntities().map((entry) => entry.describe());

/** Test seam. Production code never unregisters an entity. */
export const clearRegistry = (): void => {
  entities.clear();
  generation += 1;
};
