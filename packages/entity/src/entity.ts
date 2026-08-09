// `entity(name, { columns })` is the first primitive. The row type is DERIVED from the columns —
// there is no second declaration of the same shape to keep in sync — and everything downstream
// (the typed db handle, migrations, cache tags, the admin UI, the manifest) is projected from
// this one call.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { bindColumn, snake } from './column';
import { newId } from './columns';
import { describeEntity } from './describe';
import { invariantViolated } from './errors';
import type { Expr, InvariantColumns, Resolve } from './expr';
import { invariantColumns } from './expr';
import type { Invariant, InvariantDef } from './invariants';
import { assertInvariants, bindInvariant, invariantsToSql } from './invariants';
import type { EntityDescription } from './registry';
import { registerEntity } from './registry';
import { resolveTenantColumn } from './tenancy';
import type { AnyColumn, ColumnMap, ColumnMeta, IndexDef, RowOf } from './types';
import type { EntityView } from './view';
import { viewFor } from './view';

/** Presence of this column is what makes an entity soft-deletable — not a flag. */
export const SOFT_DELETE_COLUMN = 'deletedAt';

export interface IndexInit<C extends ColumnMap> {
  readonly on: readonly (keyof C & string)[];
  readonly order?: 'asc' | 'desc';
  readonly unique?: boolean;
  /** Partial index predicate, written in the same language as an invariant. */
  readonly where?: (columns: InvariantColumns) => Expr;
}

export interface EntityInit<C extends ColumnMap> {
  readonly columns: C;
  /**
   * The tenant column, said out loud. Omitted, it is inferred from `.tenant()` or a column named
   * `orgId`, so silence never means unscoped.
   */
  readonly tenant?: keyof C & string;
  /** Composite keys only — a single key is `uuid().primaryKey()` on the column itself. */
  readonly primaryKey?: readonly (keyof C & string)[];
  readonly invariants?: readonly InvariantDef[];
  readonly indexes?: readonly IndexInit<C>[];
  /** Extra cache tags this entity participates in, beyond its own. */
  readonly tags?: readonly string[];
}

/**
 * The row-shaped half of an entity. Consumers that must name "some entity" without naming its
 * row use `EntityCore`; `Entity` adds the columns themselves, so `orgs.id` is a column
 * reference and `typeof orgs.$row` is the derived row type.
 */
export interface EntityCore<Row = unknown, C extends ColumnMap = ColumnMap> {
  readonly $name: string;
  readonly $table: string;
  readonly $columns: C;
  readonly $primaryKey: readonly string[];
  readonly $indexes: readonly IndexDef[];
  readonly $invariants: readonly Invariant<Row>[];
  readonly $tags: readonly string[];
  /** `entity:<name>`. `@ultimat3/cache` invalidates by this string. */
  readonly $cacheTag: string;
  readonly $softDelete: boolean;
  /** Property key of the tenant column, or `null`. Presence is what turns tenancy on. */
  readonly $tenantColumn: string | null;
  /** Phantom: `type Post = typeof posts.$row`. Reading it at runtime throws. */
  readonly $row: Row;
  /** The Standard Schema the columns already describe — forms and actions hand input to it. */
  readonly $schema: StandardSchemaV1<unknown, Row>;
  /** `entity:<name>:<id>` — row-level invalidation for live queries. */
  $tagFor(id: string): string;
  /** Fills declared defaults, then validates every column. Throws on a bad value. */
  $parse(value: unknown): Row;
  /**
   * `const PostView = posts.$view(['id', 'title'])` — the projection an action names as its
   * `output`. An unknown key is a compile error, and a declaration error for a JS caller.
   */
  $view<K extends keyof Row & string>(keys: readonly K[]): EntityView<Row, K>;
  /** Runs every invariant. Called by the repository on insert and update. */
  $assert(row: Row): void;
  /** The CHECK/UNIQUE statements the migration emits for this entity. */
  $migration(): string;
  $describe(): EntityDescription;
}

export type Entity<Row, C extends ColumnMap = ColumnMap> = EntityCore<Row, C> & C;

const MONEY_PARTS = new Set(['minor', 'currency']);

const indexName = (table: string, columns: readonly string[], unique: boolean): string =>
  `${table}_${columns.join('_')}_${unique ? 'key' : 'idx'}`;

const defaultValue = (meta: ColumnMeta): unknown => {
  const declared = meta.default;
  if (declared === undefined) return undefined;
  if (declared.kind === 'value') return declared.value;
  return declared.by === 'uuid-v7' ? newId() : new Date();
};

export const entity = <const C extends ColumnMap>(
  name: string,
  init: EntityInit<C>,
): Entity<RowOf<C>, C> => {
  type Row = RowOf<C>;
  const entries: readonly (readonly [string, AnyColumn])[] = Object.entries(init.columns);
  for (const [property, column] of entries) bindColumn(column, name, property);

  const cacheTag = `entity:${name}`;
  const softDelete = Object.hasOwn(init.columns, SOFT_DELETE_COLUMN);
  const tenantColumn = resolveTenantColumn(name, init.columns, init.tenant);

  const primaryKey =
    init.primaryKey ?? entries.filter(([, column]) => column.$meta.primaryKey).map(([key]) => key);
  if (primaryKey.length === 0) {
    throw invariantViolated(
      name,
      'primary-key',
      'no primary key: mark a column .primaryKey() or pass primaryKey: [...] for a composite one',
    );
  }

  // Property path -> physical name. The one place `orgId` becomes `org_id`.
  const resolve: Resolve = (path) => {
    const [property, part] = path;
    const column = property === undefined ? undefined : init.columns[property];
    if (property === undefined || column === undefined) {
      throw invariantViolated(name, 'invariant', `no column "${String(property)}"`);
    }
    const isMoney = column.$meta.kind === 'money';
    if (part === undefined) {
      if (isMoney) {
        throw invariantViolated(
          name,
          property,
          `${property} is money: name ${property}.minor or ${property}.currency`,
        );
      }
      return snake(property);
    }
    if (!isMoney || !MONEY_PARTS.has(part)) {
      throw invariantViolated(name, property, `${property} has no part "${part}"`);
    }
    return `${snake(property)}_${part}`;
  };

  const columnsExpr = invariantColumns(
    name,
    entries.map(([property]) => property),
  );
  const partialWhere = softDelete ? `${snake(SOFT_DELETE_COLUMN)} is null` : undefined;
  const invariants: readonly Invariant<Row>[] = (init.invariants ?? []).map((def) =>
    bindInvariant<Row>(def, columnsExpr, resolve, partialWhere),
  );

  const declared: readonly IndexDef[] = [
    ...entries.flatMap(([property, column]) => {
      const meta = column.$meta;
      if (!meta.unique && !meta.index) return [];
      const physical = [meta.kind === 'money' ? `${snake(property)}_minor` : snake(property)];
      return [
        { name: indexName(name, physical, meta.unique), columns: physical, unique: meta.unique },
      ];
    }),
    ...(init.indexes ?? []).map((index) => {
      const columns = index.on.map((property) => resolve([property]));
      const unique = index.unique === true;
      const where = index.where?.(columnsExpr).toSql(resolve) ?? null;
      if (index.where !== undefined && where === null) {
        throw invariantViolated(
          name,
          'index',
          'a partial index predicate must be expressible in SQL; a JS predicate cannot be one',
        );
      }
      return {
        name: indexName(name, columns, unique),
        columns,
        unique,
        ...(index.order === undefined ? {} : { order: index.order }),
        ...(where === null ? {} : { where }),
      };
    }),
  ];
  // A foreign key already indexes its column; naming it again in `indexes` is not two indexes.
  const indexes: readonly IndexDef[] = declared.filter(
    (index, position) => declared.findIndex((other) => other.name === index.name) === position,
  );

  const tags = [cacheTag, ...(init.tags ?? [])];
  const describe = (): EntityDescription =>
    describeEntity({
      name,
      columns: entries,
      primaryKey,
      invariants,
      indexes,
      tags,
      cacheTag,
      softDelete,
      tenantColumn,
    });

  const parse = (value: unknown): Row => {
    if (typeof value !== 'object' || value === null) {
      throw invariantViolated(name, 'row', `expected an object, got ${String(value)}`);
    }
    const input = value as Readonly<Record<string, unknown>>;
    const row: Record<string, unknown> = {};
    for (const [property, column] of entries) {
      const given = input[property] ?? defaultValue(column.$meta);
      if (given === undefined || given === null) {
        if (column.$meta.notNull) {
          throw invariantViolated(name, property, 'is required and has no default');
        }
        row[property] = null;
        continue;
      }
      row[property] = column.$parse(given);
    }
    // Every property was validated by its own column above, so the shape is the derived row.
    return row as Row;
  };

  const core: EntityCore<Row, C> = {
    $name: name,
    $table: name,
    $columns: init.columns,
    $primaryKey: primaryKey,
    $indexes: indexes,
    $invariants: invariants,
    $tags: tags,
    $cacheTag: cacheTag,
    $softDelete: softDelete,
    $tenantColumn: tenantColumn,
    $schema: {
      '~standard': {
        version: 1,
        vendor: 'ultimate',
        validate: (value) => {
          try {
            return { value: parse(value) };
          } catch (error) {
            return {
              issues: [{ message: error instanceof Error ? error.message : String(error) }],
            };
          }
        },
      },
    },
    get $row(): Row {
      // Type-only. Reading it means someone expected a value where a type was meant.
      throw invariantViolated(name, '$row', '$row is a type, not a value — use typeof x.$row');
    },
    $tagFor: (id) => `${cacheTag}:${id}`,
    $parse: parse,
    $view: <K extends keyof Row & string>(keys: readonly K[]) =>
      viewFor<Row, K>(name, init.columns, keys),
    $assert: (row) => assertInvariants(name, invariants, row),
    $migration: () => invariantsToSql(name, invariants),
    $describe: describe,
  };

  registerEntity({ name, tableName: name, describe });
  // The columns land on the entity itself so `orgs.id` is a column reference; every framework
  // member is `$`-prefixed, which is why a column may be called `name`.
  return Object.assign(core, init.columns);
};
