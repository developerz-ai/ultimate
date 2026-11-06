// What the seed graph reads off one entity, structurally — the value `entity()` returns, with no
// runtime import of `@ultimat3/entity` (this barrel must not load its registry). The rules a row
// must keep come from the entity's own declaration: invariants, key, unique columns and indexes.

import type { EntityDescription, Invariant, ReferenceDescription } from '@ultimat3/entity';
import type { RowCheck } from './seed-graph-row';
import type { SeedColumn } from './seed-graph-values';

/** The members of `entity()`'s value a seed graph reads. A real entity satisfies it as is. */
export interface SeedEntity {
  readonly $name: string;
  readonly $table: string;
  readonly $columns: Readonly<Record<string, SeedColumn>>;
  /** Property keys. */
  readonly $primaryKey: readonly string[];
  readonly $tenantColumn: string | null;
  readonly $invariants: readonly Invariant<unknown>[];
  $describe(): EntityDescription;
  $references(): readonly ReferenceDescription[];
}

export interface EntityShape {
  readonly entity: SeedEntity;
  readonly name: string;
  readonly columns: readonly (readonly [string, SeedColumn])[];
  readonly references: ReadonlyMap<string, ReferenceDescription>;
  readonly checks: readonly RowCheck[];
  readonly uniques: readonly (readonly string[])[];
  /**
   * The soft-delete property, or `null`. Seeded null unless a factory builds it: a row born deleted
   * is invisible to every read.
   */
  readonly softDelete: string | null;
}

/**
 * `@ultimat3/entity`'s `SOFT_DELETE_COLUMN`, restated because this module type-imports entity only.
 * `seed-graph.test.ts` holds the two equal, so a rename there fails here.
 */
export const SEED_SOFT_DELETE_PROPERTY = 'deletedAt';

/** Physical column -> property. A money property owns all of its physical columns. */
const propertiesByColumn = (entity: SeedEntity): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  const declared = Object.keys(entity.$columns);
  for (const column of entity.$describe().columns) {
    const owner = declared.includes(column.property)
      ? column.property
      : declared.find(
          (property) =>
            entity.$columns[property]?.$meta.kind === 'money' &&
            column.property.startsWith(property),
        );
    if (owner !== undefined) map.set(column.column, owner);
  }
  return map;
};

const dedupe = (sets: readonly (readonly string[])[]): readonly (readonly string[])[] => {
  const seen = new Set<string>();
  return sets.filter((set) => {
    const key = [...set].sort().join('\u0000');
    if (set.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function shapeOf(entity: SeedEntity): EntityShape {
  const byColumn = propertiesByColumn(entity);
  const toProperties = (columns: readonly string[]): readonly string[] =>
    columns.flatMap((column) => {
      const property = byColumn.get(column);
      return property === undefined ? [] : [property];
    });
  const description = entity.$describe();
  const checks = entity.$invariants
    .filter((invariant) => invariant.kind !== 'unique')
    .map(
      (invariant): RowCheck => ({
        name: invariant.name,
        properties: toProperties(invariant.columns),
        holds: (row) => invariant.holds(row),
      }),
    );
  // A partial unique (`where`) is treated as total: stricter than the table, never looser.
  const uniques = dedupe([
    entity.$primaryKey,
    ...description.columns.filter((column) => column.unique).map((c) => toProperties([c.column])),
    ...entity.$invariants
      .filter((invariant) => invariant.kind === 'unique')
      .map((invariant) => toProperties(invariant.columns)),
    ...description.indexes.filter((index) => index.unique).map((i) => toProperties(i.columns)),
  ]);
  return {
    entity,
    name: entity.$name,
    columns: Object.entries(entity.$columns),
    references: new Map(entity.$references().map((reference) => [reference.property, reference])),
    checks,
    uniques,
    softDelete: description.softDelete ? SEED_SOFT_DELETE_PROPERTY : null,
  };
}
