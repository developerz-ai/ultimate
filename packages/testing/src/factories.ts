// Typed factories derived from the entity registry. Rows come from the entity's own columns, so a
// new NOT NULL column breaks the factory at compile time instead of at the first insert — and the
// values are seeded, so two runs of the same suite produce byte-identical rows.

import { seededRandom, seededUuid } from './determinism';

export interface EntityLike {
  readonly kind: 'entity';
  readonly table: string;
  readonly columns: Readonly<Record<string, unknown>>;
}

export interface Factory<TRow> {
  readonly table: string;
  build(over?: Partial<TRow>): TRow;
  buildMany(count: number, over?: Partial<TRow>): readonly TRow[];
  /** Restart the sequence so a second describe block sees the same ids as the first. */
  reset(): void;
}

export interface FactoryOptions<TRow> {
  readonly seed?: number;
  /** Values for every column the entity requires; called once per built row. */
  defaults(index: number, ids: { uuid(): string; number(): number }): TRow;
}

export function defineFactory<TRow extends object>(
  entity: EntityLike,
  options: FactoryOptions<TRow>,
): Factory<TRow> {
  const seed = options.seed ?? 1;
  let uuid = seededUuid(seed);
  let random = seededRandom(seed);
  let index = 0;
  const ids = {
    uuid: () => uuid(),
    number: () => Math.floor(random() * 1_000_000),
  };
  return {
    table: entity.table,
    build: (over = {}) => {
      index += 1;
      return { ...options.defaults(index, ids), ...over };
    },
    buildMany: (count, over = {}) =>
      Array.from({ length: count }, () => {
        index += 1;
        return { ...options.defaults(index, ids), ...over };
      }),
    reset: () => {
      uuid = seededUuid(seed);
      random = seededRandom(seed);
      index = 0;
    },
  };
}

export type EntityRegistry = Readonly<Record<string, EntityLike>>;

export type FactoryRegistry<TRegistry extends EntityRegistry> = {
  readonly [K in keyof TRegistry]: Factory<Record<string, unknown>>;
};

/**
 * Build one factory per registered entity, with column-name-driven defaults. Enough for the rows a
 * test does not care about; pass `defineFactory` explicitly for the rows it does.
 */
export function factoriesFor<TRegistry extends EntityRegistry>(
  registry: TRegistry,
  seed = 1,
): FactoryRegistry<TRegistry> {
  const out: Record<string, Factory<Record<string, unknown>>> = {};
  for (const [name, entity] of Object.entries(registry)) {
    out[name] = defineFactory<Record<string, unknown>>(entity, {
      seed,
      defaults: (index, ids) => {
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

function defaultFor(
  column: string,
  index: number,
  ids: { uuid(): string; number(): number },
): unknown {
  if (column === 'id' || column.endsWith('Id')) return ids.uuid();
  if (column.endsWith('At')) return new Date(0);
  if (column.endsWith('Minor')) return ids.number();
  if (column.endsWith('Currency')) return 'USD';
  if (column.startsWith('is') || column.startsWith('has')) return false;
  return `${column}-${index}`;
}
