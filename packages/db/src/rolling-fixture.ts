// Single responsibility: hand-built entity descriptions for the rolling-deploy suites, one spelling
// so `foreign-key-plan`, `concurrent-plan` and `generate-rolling` cannot drift apart on what a table is.

import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';

export const AT = new Date('2026-11-02T12:00:00.000Z');

export const uuidColumn = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'uuid',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

export const textColumn = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => uuidColumn(name, { kind: 'text', notNull: false, ...overrides });

export const tableOf = (
  name: string,
  columns: readonly ColumnDescriptionLike[] = [],
  extra: Partial<EntityDescriptionLike> = {},
): EntityDescriptionLike => ({
  name,
  table: name,
  primaryKey: ['id'],
  columns: [uuidColumn('id', { primaryKey: true }), ...columns],
  indexes: [],
  ...extra,
});
