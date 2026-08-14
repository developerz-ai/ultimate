// The projection an entity hands the rest of the toolchain: `x.manifest.json`, the migration
// generator, the admin dashboard and `x entities`. It is a plain data snapshot on purpose —
// a consumer must be able to read the whole domain without importing a single schema module.
//
// Money is the one place the projection is not one-to-one: one property becomes the two
// physical columns that back it.

import { referenceBinding, snake } from './column';
import { currencyCheck } from './columns';
import type { Invariant } from './invariants';
import type { ColumnDescription, EntityDescription, ReferenceDescription } from './registry';
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

/**
 * The foreign keys an entity declares, resolved through the one binding resolver. Money is
 * skipped for the reason the DDL projection drops a reference there too: one property is two
 * physical columns, so `snake(property)` names neither of them, and a relation and a foreign-key
 * constraint must not disagree about which columns exist.
 */
export const describeReferences = (
  entityName: string,
  columns: readonly (readonly [string, AnyColumn])[],
): readonly ReferenceDescription[] =>
  columns.flatMap(([property, column]) => {
    const meta = column.$meta;
    if (meta.kind === 'money') return [];
    const target = referenceBinding(entityName, property, meta);
    if (target === null) return [];
    return [
      {
        property,
        column: snake(property),
        nullable: !meta.notNull,
        targetEntity: target.table,
        targetProperty: target.property,
        targetColumn: target.name,
      },
    ];
  });

const describeColumn = <Row>(
  input: DescribeInput<Row>,
  property: string,
  meta: ColumnMeta,
  reference: ReferenceDescription | undefined,
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
      // Rendered from the resolved record, so the string a migration reads and the record a
      // traversal reads can never disagree about what a `references()` points at.
      references:
        reference === undefined ? null : `${reference.targetEntity}.${reference.targetColumn}`,
    },
  ];
};

export const describeEntity = <Row>(input: DescribeInput<Row>): EntityDescription => {
  const references = new Map(
    describeReferences(input.name, input.columns).map((reference) => [
      reference.property,
      reference,
    ]),
  );
  return {
    name: input.name,
    table: input.name,
    primaryKey: input.primaryKey.map((property) => snake(property)),
    columns: input.columns.flatMap(([property, column]) =>
      describeColumn(input, property, column.$meta, references.get(property)),
    ),
    invariants: input.invariants.map((inv) => ({
      name: inv.name,
      kind: inv.kind,
      message: inv.message,
      sql: inv.sql,
      where: inv.where ?? null,
    })),
    // Projected whole, never reduced to the name: the generator spells the column list from this
    // and a name cannot be parsed back into one. See `IndexDescription`.
    indexes: input.indexes.map((index) => ({
      name: index.name,
      columns: index.columns,
      unique: index.unique,
      where: index.where ?? null,
      order: index.order ?? null,
    })),
    tags: input.tags,
    cacheTag: input.cacheTag,
    softDelete: input.softDelete,
    orgScoped: input.tenantColumn !== null,
  };
};
