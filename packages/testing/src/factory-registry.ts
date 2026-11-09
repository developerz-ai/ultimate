// One factory per registered entity, each value read off its column's declaration — kind,
// nullability, enumerated values, money parts, default — through the seed graph's one value
// source. Enough for the rows a test does not care about; `defineFactory` is for the ones it does.

import { defineFactory } from './factories';
import type { Factory } from './factory-api';
import type { EntityLike, FactoryIds } from './factory-types';
import { seedGraphUnsatisfied } from './seed-graph-error';
import { declaredPatterns } from './seed-graph-patterns';
import { SEED_SOFT_DELETE_PROPERTY, type SeedEntity } from './seed-graph-shape';
import { candidatesFor, isSeedColumn } from './seed-graph-values';

export type EntityRegistry = Readonly<Record<string, EntityLike>>;

export type FactoryRegistry<TRegistry extends EntityRegistry> = {
  readonly [K in keyof TRegistry]: Factory<Record<string, unknown>>;
};

/**
 * `seed` is deliberately optional and deliberately not shared: with one seed for the whole
 * registry every table drew the same uuid stream, so a user and a post came out with the same id.
 * Omitted, each factory derives its own from its table name — still reproducible, no longer equal.
 */
export function factoriesFor<TRegistry extends EntityRegistry>(
  registry: TRegistry,
  seed?: number,
): FactoryRegistry<TRegistry> {
  const out: Record<string, Factory<Record<string, unknown>>> = {};
  for (const [name, entity] of Object.entries(registry)) {
    const patterns = hasInvariants(entity) ? declaredPatterns(entity) : new Map();
    out[name] = defineFactory(entity, {
      ...(seed === undefined ? {} : { seed }),
      defaults: (index, ids): Record<string, unknown> => {
        const row: Record<string, unknown> = {};
        Object.entries(entity.$columns).forEach(([property, column], position) => {
          row[property] = defaultFor(
            { table: entity.$table, property, column, position, patterns: patterns.get(property) },
            index,
            ids,
          );
        });
        return row;
      },
    });
  }
  return out as FactoryRegistry<TRegistry>;
}

/** An `entity()` value, which declares rules; a hand-built `EntityLike` may declare none. */
const hasInvariants = (entity: object): entity is Pick<SeedEntity, '$invariants' | '$describe'> =>
  '$invariants' in entity &&
  Array.isArray(entity.$invariants) &&
  '$describe' in entity &&
  typeof entity.$describe === 'function';

/** One column of one entity: what `defaultFor` reads. The name labels a refusal, nothing more. */
export interface DefaultColumn {
  readonly table: string;
  readonly property: string;
  readonly column: unknown;
  readonly position: number;
  /** The `matches()` patterns the entity holds this column to (`declaredPatterns`). */
  readonly patterns?: readonly RegExp[] | undefined;
}

/**
 * The first value the column's own declaration admits — its default, else what its kind offers.
 * A value that is not an `entity()` column, or a column that refuses every generated value, is
 * `X_SEED_GRAPH_UNSATISFIED`: the fix is a `defineFactory` naming that column.
 */
export function defaultFor(target: DefaultColumn, index: number, ids: FactoryIds): unknown {
  const { column, property, table } = target;
  // A built row is a LIVE one: a soft-delete instant would hide it from every read, as `seedGraph`
  // already keeps it `null` (`seed-graph.ts`).
  if (property === SEED_SOFT_DELETE_PROPERTY && isSeedColumn(column) && !column.$meta.notNull) {
    return null;
  }
  const values = isSeedColumn(column)
    ? candidatesFor(property, column, {
        ordinal: index,
        canary: String(index),
        position: target.position,
        patterns: target.patterns,
        uuid: () => ids.uuid(),
      })
    : [];
  if (values.length === 0) {
    throw seedGraphUnsatisfied({
      entity: table,
      what: isSeedColumn(column)
        ? `no generated value is storable in ${property} — its column refuses every one`
        : `${property} is not an entity() column, so it declares nothing to generate from`,
      columns: [property],
    });
  }
  return values[0];
}
