// The toy store of `entity/src/define-driver.test.ts`, grown only by what the suite asks of every
// store: a Map per table read through the kit's `selectRows`, writes all or nothing, and the
// declared unique constraints refused as `entityUniqueViolation`. It declares no capability, so
// the suite proves each one REFUSED by name — the path a third-party store starts on.

import type { EntityCore } from '@ultimat3/entity';
import { columnName } from '@ultimat3/entity';
import type { DriverDefinition, DriverFilter, DriverRepo } from '@ultimat3/entity/adapter';
import {
  compareByKind,
  entityUniqueViolation,
  kindOf,
  rowKey,
  selectRows,
  uniqueConstraints,
  valueAt,
} from '@ultimat3/entity/adapter';

/** Physical column -> property, so a constraint's columns read the row the kit hands over. */
const propertiesOf = (table: EntityCore): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(table.$columns).map(([property, column]) => [
      columnName(property, column.$meta),
      property,
    ]),
  );

/** The first constraint a candidate table breaks, by value (`2.5` and `2.50` are one), or none. */
const brokenConstraint = <Row>(
  table: EntityCore<Row>,
  rows: readonly Row[],
): string | undefined => {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = rowKey(table, row);
    if (keys.has(key)) return `${table.$table}_pkey`;
    keys.add(key);
  }
  const physical = propertiesOf(table as EntityCore);
  for (const constraint of uniqueConstraints(table)) {
    const columns = constraint.columns.map((name) => physical.get(name) ?? name);
    const compare = (a: Row, b: Row): number => {
      for (const property of columns) {
        const order = compareByKind(
          kindOf(table, property),
          valueAt(a, property),
          valueAt(b, property),
        );
        if (order !== 0) return order;
      }
      return 0;
    };
    // SQL NULL is distinct from every value, itself included: such a row never collides.
    const keyed = rows.filter((row) => columns.every((property) => valueAt(row, property) != null));
    const sorted = [...keyed].sort(compare);
    for (const [index, row] of sorted.entries()) {
      const next = sorted[index + 1];
      if (next !== undefined && compare(row, next) === 0) return constraint.name();
    }
  }
  return undefined;
};

export const toyStore = (): DriverDefinition => {
  const tables = new Map<string, unknown[]>();
  return {
    name: 'toy',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = (): Row[] => (tables.get(table.$name) ?? []) as Row[];
      /** Validates the whole candidate table, then swaps it in: a write lands whole or not at all. */
      const commit = (next: readonly Row[]): void => {
        const broken = brokenConstraint(table, next);
        if (broken !== undefined) throw entityUniqueViolation(table as EntityCore, broken);
        tables.set(table.$name, [...next]);
      };
      const matched = (filter: DriverFilter): Set<Row> =>
        new Set(
          selectRows(table, rows(), { plan: filter.plan, after: undefined, limit: rows().length }),
        );
      return {
        select: async (read) => selectRows(table, rows(), read),
        count: async (filter) => matched(filter).size,
        insert: async (batch) => {
          commit([...rows(), ...batch]);
          return batch;
        },
        update: async (filter, patch) => {
          const hit = matched(filter);
          commit(rows().map((row) => (hit.has(row) ? { ...row, ...patch } : row)));
          return hit.size;
        },
        delete: async (filter) => {
          const hit = matched(filter);
          commit(rows().filter((row) => !hit.has(row)));
          return hit.size;
        },
      };
    },
    reset: () => tables.clear(),
  };
};
