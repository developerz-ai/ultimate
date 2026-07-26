// The entity registry. Every `entity()` call registers here, which is what makes
// `x.manifest.json`, the admin dashboard generator and the migration emitter able to
// see the whole domain without importing it — and what makes a duplicate name a
// build error rather than a silent last-one-wins.
import { entityDuplicate } from './errors';

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
}

export interface InvariantDescription {
  readonly name: string;
  readonly kind: 'check' | 'unique';
  readonly message: string;
  readonly sql: string;
  readonly where: string | null;
}

export interface EntityDescription {
  readonly name: string;
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnDescription[];
  readonly invariants: readonly InvariantDescription[];
  readonly indexes: readonly string[];
  readonly tags: readonly string[];
  readonly cacheTag: string;
  readonly softDelete: boolean;
  readonly orgScoped: boolean;
}

export interface RegistryEntry {
  readonly name: string;
  readonly tableName: string;
  describe(): EntityDescription;
}

const entities = new Map<string, RegistryEntry>();

export const registerEntity = <E extends RegistryEntry>(entry: E): E => {
  const existing = entities.get(entry.name);
  if (existing !== undefined && existing !== entry) {
    throw entityDuplicate(entry.name, existing.tableName);
  }
  entities.set(entry.name, entry);
  return entry;
};

export const getEntity = (name: string): RegistryEntry | undefined => entities.get(name);

export const entityNames = (): readonly string[] => [...entities.keys()].sort();

/** Deterministic order: the manifest is a build artefact and must diff cleanly. */
export const describeEntities = (): readonly EntityDescription[] =>
  entityNames().map((name) => {
    const entry = entities.get(name);
    if (entry === undefined) throw entityDuplicate(name, 'unknown');
    return entry.describe();
  });

/** Test seam. Production code never unregisters an entity. */
export const clearRegistry = (): void => entities.clear();
