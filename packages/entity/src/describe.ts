// The projection an entity hands the rest of the toolchain: `x.manifest.json`, the migration
// generator, the admin dashboard and `x entities`. It is a plain data snapshot on purpose —
// a consumer must be able to read the whole domain without importing a single schema module.
//
// Money is the one place the projection is not one-to-one: one property becomes the two
// physical columns that back it.

import { type Binding, bindingOf, columnName, moneyColumns, referenceBinding } from './column';
import { currencyCheck, scaleCheck } from './columns';
import { EntityError, invariantViolated } from './errors';
import type { Invariant } from './invariants';
import type { LifecycleDescription } from './lifecycle';
import type {
  ColumnDescription,
  EntityDescription,
  ReferenceDescription,
  SameTenantKey,
} from './registry';
import type { SearchVector } from './search';
import type { AnyColumn, ColumnMeta, IndexDef } from './types';
import type { ViewQuery } from './view-entity';

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
  /** The generated `tsvector`, when any column is `.searchable()`. */
  readonly search?: SearchVector | null;
  /** `entity({ appendOnly: true })` — projected only when true. */
  readonly appendOnly?: boolean;
  /** `entity({ retired: [...] })` — physical names, projected only when there are any. */
  readonly retired?: readonly string[] | undefined;
  /** `entity({ shared: '<why>' })` — projected only when declared. */
  readonly shared?: string | undefined;
  /** `entity({ scan: '<why>' })` — projected only when declared. */
  readonly scan?: string | undefined;
  /** `entity({ view })` — projected only when declared. */
  readonly view?: ViewQuery | null | undefined;
  /** `retain`, `history`, `countedIn` counters — each projected only when declared (`lifecycle.ts`). */
  readonly lifecycle?: LifecycleDescription | undefined;
}

/**
 * The search vector as a physical column: `tsvector`, computed by the database, never written.
 *
 * `notNull` is what makes a missing `generated` clause LOUD rather than silent. Every function in
 * the expression is total over a coalesced text, so the value can never be NULL — and if a
 * generator that does not yet render `generated` emits the column as a plain `tsvector`, the first
 * insert is a `23502` naming this column, instead of a table of NULL vectors where every search
 * quietly answers nothing.
 */
const describeSearchColumn = (search: SearchVector): ColumnDescription => ({
  // `$`-prefixed: a property key no column can be spelled as, because nothing may address it.
  property: '$search',
  column: search.column,
  kind: 'tsvector',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  onDelete: null,
  generated: search.expression,
});

/**
 * Whether this edge holds its two ends to one tenant. Decided here because a thunk can only be
 * answered once both modules evaluated, and from the bindings because they alone know each side's
 * physical tenant column.
 *
 * Both ends scoped, and neither end IS the tenant column: `orgId -> orgs.id` is the tenant's own
 * root, where a composite would pair a column with itself. A `crossTenant` reason on an edge that
 * could never be same-tenant is refused, or it would state a reason for nothing and read as a
 * decision someone took.
 */
const sameTenantOf = (
  entityName: string,
  property: string,
  meta: ColumnMeta,
  own: Binding | undefined,
  target: Binding,
): SameTenantKey | null => {
  const column = own?.tenant ?? null;
  const targetColumn = target.tenant;
  const eligible =
    own !== undefined &&
    column !== null &&
    targetColumn !== null &&
    own.name !== column &&
    target.name !== targetColumn;
  if (!eligible) {
    if (meta.crossTenant === undefined) return null;
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${entityName}.${property} states crossTenant on an edge that is not same-tenant: ${target.table} and ${entityName} do not both carry a tenant, or the column is the tenant column itself`,
      fix: `references(() => ${target.table}.${target.property}) — in the columns of ${entityName}, with the crossTenant option removed`,
    });
  }
  return meta.crossTenant === undefined ? { column, targetColumn } : null;
};

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
        targetTable: target.physicalTable,
        targetProperty: target.property,
        targetColumn: target.name,
        onDelete: meta.onDelete ?? null,
        sameTenant: sameTenantOf(entityName, property, meta, bindingOf(column), target),
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

/**
 * At declaration, on the physical names: the same word in both lists is a column read by the release
 * that says it stopped, and `x db gen` could only answer later and further away. Never through
 * `describeEntity`: that answers a `references()` thunk, and a self-reference or a schema cycle is
 * still in its temporal dead zone at this point.
 */
export const assertNotRetired = (
  entityName: string,
  entries: readonly (readonly [string, AnyColumn])[],
  retired: readonly string[] | undefined,
): void => {
  for (const [property, column] of entries) {
    const parts = column.$meta.kind === 'money' ? moneyColumns(property, column.$meta) : null;
    const physical =
      parts === null
        ? [columnName(property, column.$meta)]
        : [parts.minor, parts.currency, ...(parts.scale === null ? [] : [parts.scale])];
    const held = physical.find((each) => retired?.includes(each) === true);
    if (held !== undefined) {
      throw invariantViolated(
        entityName,
        held,
        'is listed under retired and still declared in columns; a column is one or the other',
      );
    }
  }
};

/**
 * `shared` is a reason, so a blank one is no reason: refused where it was written, never read as a
 * declaration someone took. On an entity WITH a tenant column it states a reason for nothing — the
 * stance `sameTenantOf` takes on a `crossTenant` reason for an edge that cannot be same-tenant.
 */
export const assertShared = (
  entityName: string,
  table: string,
  shared: string | undefined,
  tenantColumn: string | null,
): void => {
  if (shared === undefined) return;
  if (shared.trim() === '') {
    throw new EntityError({
      code: 'X_ENTITY_TENANT_UNDECLARED',
      cause: `${entityName} declares shared with no reason: a blank reason says nothing about why its rows belong to no tenant`,
      fix: `entity('${entityName}', { shared: '<why it belongs to no tenant>' }) — or drop shared, add orgId: uuid().tenant() to its columns, then x db gen "${table} tenant"`,
    });
  }
  if (tenantColumn !== null) {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${entityName} declares shared and has the tenant column ${tenantColumn}: its rows belong to a tenant, so the reason explains nothing`,
      fix: `entity('${entityName}', { … }) — with the shared option removed`,
    });
  }
};

/**
 * `scan` is a reason, like `shared`: a blank one is no reason, and a table a plan check skips with
 * no argument is a silenced finding nobody can tell from a considered one.
 */
export const assertScan = (entityName: string, scan: string | undefined): void => {
  if (scan === undefined || scan.trim() !== '') return;
  throw new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName} declares scan with no reason: a blank reason says nothing about why the table stays small enough to read whole`,
    fix: `entity('${entityName}', { scan: '<why it stays small, e.g. a closed catalog of 8 rows>' }) — or drop scan and add the index x exercise --json names`,
  });
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
      // The value beside the boolean: `@ultimat3/db` renders it, and without it the generator
      // could only infer two expressions and dropped every other default without saying so.
      ...(meta.default === undefined ? {} : { default: meta.default }),
      check: meta.check?.(physical) ?? null,
      // Rendered from the resolved record, so the string a migration reads and the record a
      // traversal reads can never disagree about what a `references()` points at.
      references:
        reference === undefined ? null : `${reference.targetTable}.${reference.targetColumn}`,
      // Off the resolved reference, never off `meta` again: a rule with no key is not a thing, and
      // reading the option twice is two places for the pair to disagree.
      onDelete: reference?.onDelete ?? null,
      // `true`-or-absent's cousin: absent, so no entity without such an edge moves the hash.
      ...(reference?.sameTenant == null ? {} : { sameTenant: reference.sameTenant }),
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
    columns: [
      ...input.columns.flatMap(([property, column]) =>
        describeColumn(input, property, column.$meta, references.get(property)),
      ),
      // LAST, so every column an author declared keeps the position it had and no snapshot of an
      // entity without a search vector moves.
      ...(input.search == null ? [] : [describeSearchColumn(input.search)]),
    ],
    // `columns` rides along whole: the generator needs the list a `unique` names, and recovering
    // it by splitting `sql` is reading this package's own rendering back. See InvariantDescription.
    invariants: input.invariants.map((inv) => ({
      name: inv.name,
      kind: inv.kind,
      message: inv.message,
      sql: inv.sql,
      where: inv.where ?? null,
      columns: inv.columns,
    })),
    // Projected whole, never reduced to the name: the generator spells the column list from this
    // and a name cannot be parsed back into one. See `IndexDescription`.
    indexes: input.indexes.map((index) => ({
      name: index.name,
      columns: index.columns,
      unique: index.unique,
      where: index.where ?? null,
      order: index.order ?? null,
      // Spread, never `?? null`: absent is what `@ultimat3/db` reads as the btree it always was,
      // and a written-out `null` would be a field no existing snapshot carries.
      ...(index.using === undefined ? {} : { using: index.using }),
      // `true` or absent, never `false`, for the same reason: `x verify` hashes this projection.
      ...(index.concurrently === true ? { concurrently: true as const } : {}),
    })),
    tags: input.tags,
    cacheTag: input.cacheTag,
    softDelete: input.softDelete,
    orgScoped: input.tenantColumn !== null,
    // `true` or absent, never `false`: `x verify`'s source drift hashes this projection as JSON,
    // and an entity that never said `appendOnly` must hash exactly what it hashed before.
    ...(input.appendOnly === true ? { appendOnly: true as const } : {}),
    ...((input.retired ?? []).length === 0 ? {} : { retired: input.retired }),
    // Absent unless declared, like `appendOnly`: no entity that never said it moves the hash.
    ...(input.shared === undefined ? {} : { shared: input.shared }),
    ...(input.scan === undefined ? {} : { scan: input.scan }),
    // Absent on every table, so no entity that never said `view` moves the hash.
    ...(input.view === null || input.view === undefined
      ? {}
      : {
          view: {
            sql: input.view.sql,
            ...(input.view.materialized ? { materialized: true as const } : {}),
          },
        }),
    ...input.lifecycle,
  };
};
