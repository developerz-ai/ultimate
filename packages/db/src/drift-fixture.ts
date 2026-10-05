// TEST-ONLY. The two builders every drift suite compares with — a `TableDescription` of text
// columns and the `SchemaDescription` around it. One copy, because three suites arguing about
// schemas built differently would each be judging a different fixture. Never exported from
// `index.ts`.

import type { SchemaDescription, TableDescription } from './introspect';

export const table = (name: string, columns: readonly string[]): TableDescription => ({
  schema: 'public',
  name,
  columns: columns.map((column, index) => ({
    name: column,
    dataType: 'text',
    nullable: true,
    default: null,
    position: index + 1,
  })),
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
});

export const schema = (...tables: readonly TableDescription[]): SchemaDescription => ({ tables });
