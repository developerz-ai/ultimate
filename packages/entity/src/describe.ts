// The projection an entity hands the rest of the toolchain: `x.manifest.json`, the migration
// generator, the admin dashboard and `x entities`. It is a plain data snapshot on purpose —
// a consumer must be able to read the whole domain without importing a single schema module.
//
// Money is the one place the projection is not one-to-one: one property becomes the two
// physical columns that back it.

import { bindingOf, snake } from './column';
import { currencyCheck } from './columns';
import { invariantViolated } from './errors';
import type { Invariant } from './invariants';
import type { ColumnDescription, EntityDescription } from './registry';
import type { AnyColumn, ColumnMeta, IndexDef } from './types';

export interface DescribeInput<Row> {
  readonly name: string;
  readonly columns: readonly (readonly [string, AnyColumn])[];
  readonly primaryKey: readonly string[];
  readonly invariants: readonly Invariant<Row>[];
  readonly indexes: readonly IndexDef[];
  readonly tags: readonly string[];
  readonly cacheTag: string;
  readonly softDelete: boolean;
  readonly tenantColumn: string | null;
}

const referenceOf = (entityName: string, property: string, meta: ColumnMeta): string | null => {
  if (meta.references === undefined) return null;
  const target = bindingOf(meta.references());
  if (target === undefined) {
    throw invariantViolated(
      entityName,
      property,
      'references a column that belongs to no entity — pass a column of an entity() result',
    );
  }
  return `${target.table}.${target.name}`;
};

const describeColumn = <Row>(
  input: DescribeInput<Row>,
  property: string,
  meta: ColumnMeta,
): readonly ColumnDescription[] => {
  const physical = snake(property);
  if (meta.kind === 'money') {
    const currency = `${physical}_currency`;
    const shared = {
      notNull: meta.notNull,
      primaryKey: false,
      unique: false,
      hasDefault: false,
      references: null,
    };
    return [
      {
        property: `${property}Minor`,
        column: `${physical}_minor`,
        kind: 'bigint',
        check: null,
        ...shared,
      },
      {
        property: `${property}Currency`,
        column: currency,
        kind: 'char',
        check: currencyCheck(currency),
        ...shared,
      },
    ];
  }
  return [
    {
      property,
      column: physical,
      kind: meta.kind,
      notNull: meta.notNull,
      primaryKey: meta.primaryKey || input.primaryKey.includes(property),
      unique: meta.unique,
      hasDefault: meta.default !== undefined,
      check: meta.check?.(physical) ?? null,
      references: referenceOf(input.name, property, meta),
    },
  ];
};

export const describeEntity = <Row>(input: DescribeInput<Row>): EntityDescription => ({
  name: input.name,
  table: input.name,
  primaryKey: input.primaryKey.map((property) => snake(property)),
  columns: input.columns.flatMap(([property, column]) =>
    describeColumn(input, property, column.$meta),
  ),
  invariants: input.invariants.map((inv) => ({
    name: inv.name,
    kind: inv.kind,
    message: inv.message,
    sql: inv.sql,
    where: inv.where ?? null,
  })),
  indexes: input.indexes.map((index) => index.name),
  tags: input.tags,
  cacheTag: input.cacheTag,
  softDelete: input.softDelete,
  orgScoped: input.tenantColumn !== null,
});
