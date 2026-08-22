// The projection an entity hands the rest of the toolchain: `x.manifest.json`, the migration
// generator, the admin dashboard and `x entities`. It is a plain data snapshot on purpose —
// a consumer must be able to read the whole domain without importing a single schema module.
//
// Money is the one place the projection is not one-to-one: one property becomes the two
// physical columns that back it.

import { columnName, moneyColumns, referenceBinding } from './column';
import { currencyCheck, scaleCheck } from './columns';
import type { Invariant } from './invariants';
import type { ColumnDescription, EntityDescription, ReferenceDescription } from './registry';
import type { AnyColumn, ColumnMeta, IndexDef } from './types';

export interface DescribeInput<Row> {
  readonly name: string;
  /** The physical table. The entity's own name unless `entity(name, { table })` said otherwise. */
  readonly table: string;
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
        column: columnName(property, meta),
        nullable: !meta.notNull,
        targetEntity: target.table,
        targetProperty: target.property,
        targetColumn: target.name,
        onDelete: meta.onDelete ?? null,
      },
    ];
  });

/**
 * The Postgres type a column becomes. `kind` is what the migration generator reads and its table
 * falls through to the kind itself for anything it does not name (`SQL_TYPES[kind] ?? kind`), so a
 * precise type belongs HERE, where the precision, the element and the length are still in scope —
 * the alternative is a second copy of the column vocabulary inside `@ultimat3/db`.
 */
export const sqlTypeOf = (meta: ColumnMeta): string => {
  if (meta.kind === 'numeric') {
    return meta.precision === undefined || meta.numericScale === undefined
      ? 'numeric'
      : `numeric(${meta.precision}, ${meta.numericScale})`;
  }
  if (meta.kind === 'array') {
    const element = meta.element?.$meta;
    // The element KIND is bounded by `arrayOf`, which refuses money, a nested array, `jsonb` and
    // `bytea` at declaration — it refused only the first two until 2026-08, so this line emitted a
    // real `jsonb[]`/`bytea[]` for a column `bindValues` wrote as `{"",""}`: a DDL type for a value
    // that could not survive the trip. What is NOT bounded is `element` itself, which is absent on
    // any `ColumnMeta` nobody built through `arrayOf()`; `text[]` keeps such a description
    // renderable rather than throwing inside a projection, the one place an error has no caller to
    // instruct.
    return `${element === undefined ? 'text' : sqlTypeOf(element)}[]`;
  }
  return meta.kind;
};

const describeColumn = <Row>(
  input: DescribeInput<Row>,
  property: string,
  meta: ColumnMeta,
  reference: ReferenceDescription | undefined,
): readonly ColumnDescription[] => {
  const physical = columnName(property, meta);
  if (meta.kind === 'money') {
    const parts = moneyColumns(property, meta);
    const currency = parts.currency;
    const shared = {
      notNull: meta.notNull,
      primaryKey: false,
      unique: false,
      hasDefault: false,
      references: null,
      onDelete: null,
    };
    return [
      {
        property: `${property}Minor`,
        column: parts.minor,
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
      // Always nullable, whatever the property's own nullability: NULL is how a row says "the
      // currency's own minor unit", which is every amount written before the column existed and
      // every ordinary price after it. A NOT NULL here would demand a scale on values that have
      // none, and `0` is not that value — it means whole units.
      //
      // Absent entirely when the table has none: an adopted amount column predating scale is two
      // physical columns, and describing a third would put a column in the DDL and in every
      // statement that the table does not have.
      ...(parts.scale === null
        ? []
        : [
            {
              property: `${property}Scale`,
              column: parts.scale,
              kind: 'integer',
              check: scaleCheck(parts.scale),
              ...shared,
              notNull: false,
            },
          ]),
    ];
  }
  return [
    {
      property,
      column: physical,
      kind: sqlTypeOf(meta),
      notNull: meta.notNull,
      primaryKey: meta.primaryKey || input.primaryKey.includes(property),
      unique: meta.unique,
      hasDefault: meta.default !== undefined,
      check: meta.check?.(physical) ?? null,
      // Rendered from the resolved record, so the string a migration reads and the record a
      // traversal reads can never disagree about what a `references()` points at.
      references:
        reference === undefined ? null : `${reference.targetEntity}.${reference.targetColumn}`,
      // Off the resolved reference, never off `meta` again: a rule with no key is not a thing, and
      // reading the option twice is two places for the pair to disagree.
      onDelete: reference?.onDelete ?? null,
    },
  ];
};

export const describeEntity = <Row>(input: DescribeInput<Row>): EntityDescription => {
  const physicalOf = (property: string): string => {
    const column = input.columns.find(([key]) => key === property)?.[1];
    return column === undefined ? property : columnName(property, column.$meta);
  };
  const references = new Map(
    describeReferences(input.name, input.columns).map((reference) => [
      reference.property,
      reference,
    ]),
  );
  return {
    name: input.name,
    table: input.table,
    primaryKey: input.primaryKey.map(physicalOf),
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
