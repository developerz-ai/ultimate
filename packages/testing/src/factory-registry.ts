// One factory per registered entity, with defaults inferred from column names. Enough for the rows
// a test does not care about; `defineFactory` is what a test reaches for when it cares.

import type { EntityLike, Factory, FactoryIds } from './factories';
import { defineFactory } from './factories';

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
    out[name] = defineFactory(entity, {
      ...(seed === undefined ? {} : { seed }),
      defaults: (index, ids): Record<string, unknown> => {
        const row: Record<string, unknown> = {};
        for (const column of Object.keys(entity.columns)) {
          row[column] = defaultFor(column, index, ids);
        }
        return row;
      },
    });
  }
  return out as FactoryRegistry<TRegistry>;
}

/**
 * Column names carry the type in this framework's conventions — `…At` is a timestamp, `…Minor` is
 * the integer half of a Money, `is…`/`has…` is a flag — so the name is the only input that can
 * produce a value the schema will accept without the test saying anything.
 */
export function defaultFor(column: string, index: number, ids: FactoryIds): unknown {
  if (column === 'id' || column.endsWith('Id')) return ids.uuid();
  if (column.endsWith('At')) return new Date(0);
  if (column.endsWith('Minor')) return ids.number();
  if (column.endsWith('Currency')) return 'USD';
  if (column.startsWith('is') || column.startsWith('has')) return false;
  return `${column}-${index}`;
}
