// A minimal custom store used to exercise the driver kit's guards.
import { selectRows } from './adapter';
import type { DriverDefinition, DriverRepo } from './define-driver';
import { entityUniqueViolation } from './driver-errors';
import type { EntityCore } from './entity';

export const toyStore = (overrides: Partial<DriverRepo<unknown>> = {}): DriverDefinition => {
  const tables = new Map<string, Map<string, unknown>>();
  return {
    name: 'toy',
    capabilities: [],
    repo: <Row>(table: EntityCore<Row>): DriverRepo<Row> => {
      const rows = (tables.get(table.$name) ?? new Map<string, Row>()) as Map<string, Row>;
      tables.set(table.$name, rows as Map<string, unknown>);
      const keyOf = (row: Row): string =>
        JSON.stringify(table.$primaryKey.map((key) => (row as Record<string, unknown>)[key]));
      const matched = (where: Parameters<DriverRepo<Row>['count']>[0]): Row[] =>
        selectRows(table, rows.values(), { plan: where.plan, after: undefined, limit: rows.size });
      return {
        select: async (read) => selectRows(table, rows.values(), read),
        count: async (where) => matched(where).length,
        insert: async (batch) => {
          for (const row of batch) {
            if (rows.has(keyOf(row))) throw entityUniqueViolation(table, `${table.$table}_pkey`);
          }
          for (const row of batch) rows.set(keyOf(row), row);
          return batch;
        },
        update: async (where, patch) => {
          const hit = matched(where);
          for (const row of hit) rows.set(keyOf(row), { ...row, ...patch });
          return hit.length;
        },
        updateChecked: async (where, judge) => {
          const hit = matched(where);
          const patch = await judge(hit);
          for (const row of hit) rows.set(keyOf(row), { ...row, ...patch });
          return hit.length;
        },
        delete: async (where) => {
          const hit = matched(where);
          for (const row of hit) rows.delete(keyOf(row));
          return hit.length;
        },
        ...(overrides as Partial<DriverRepo<Row>>),
      };
    },
    reset: () => tables.clear(),
  };
};
