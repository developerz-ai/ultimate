// `entity()` is the first primitive: a table, its domain type, and the invariants
// that hold for every row. Everything downstream (repo, admin UI, cache tags, the
// manifest) is derived from this one declaration.
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { invariantViolated } from './errors';
import { assertInvariants, type Invariant, invariantsToSql } from './invariants';
import { type EntityDescription, registerEntity } from './registry';
import { isOrgScoped } from './tenancy';
import type { ColumnMap, TableDef } from './types';

export type EntitySchema<T> = StandardSchemaV1<unknown, T>;

export interface EntityInit<T, C extends ColumnMap> {
  /** Defaults to the table name. Must be unique across the app. */
  readonly name?: string;
  readonly table: TableDef<C>;
  readonly type: EntitySchema<T>;
  readonly invariants?: readonly Invariant<T>[];
  /** Extra cache tags this entity participates in, beyond its own. */
  readonly tags?: readonly string[];
  /** Defaults to the presence of a `deletedAt` column. */
  readonly softDelete?: boolean;
}

export interface Entity<T, C extends ColumnMap = ColumnMap> {
  readonly name: string;
  readonly table: TableDef<C>;
  readonly type: EntitySchema<T>;
  readonly invariants: readonly Invariant<T>[];
  readonly tags: readonly string[];
  /** `entity:<name>`. `@ultimat3/cache` invalidates by this string. */
  readonly cacheTag: string;
  readonly softDelete: boolean;
  readonly orgScoped: boolean;
  /** `entity:<name>:<id>` — row-level invalidation for live queries. */
  tagFor(id: string): string;
  /** Validates an unknown value into the domain type. Throws on failure. */
  parse(value: unknown): T;
  /** Runs every invariant. Called by the repository on insert and update. */
  assert(row: T): void;
  /** The CHECK/UNIQUE statements the migration emits for this entity. */
  migration(): string;
  describe(): EntityDescription;
}

interface LooseResult<T> {
  readonly value?: T;
  readonly issues?: readonly { readonly message: string }[] | undefined;
}

const parseWith = <T>(schema: EntitySchema<T>, name: string, value: unknown): T => {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw invariantViolated(name, 'schema', 'entity types must validate synchronously');
  }
  const outcome = result as LooseResult<T>;
  if (outcome.issues !== undefined && outcome.issues.length > 0) {
    throw invariantViolated(name, 'schema', outcome.issues.map((i) => i.message).join('; '));
  }
  return outcome.value as T;
};

export const entity = <T, C extends ColumnMap>(init: EntityInit<T, C>): Entity<T, C> => {
  const name = init.name ?? init.table.name;
  const invariants = init.invariants ?? [];
  const softDelete = init.softDelete ?? Object.hasOwn(init.table.columns, 'deletedAt');
  const orgScoped = isOrgScoped(init.table);
  const cacheTag = `entity:${name}`;

  const describe = (): EntityDescription => ({
    name,
    table: init.table.name,
    primaryKey: init.table.primaryKey,
    columns: Object.entries(init.table.columns).map(([property, column]) => ({
      property,
      column: column.name,
      kind: column.kind,
      notNull: column.notNull,
      primaryKey: column.primaryKey,
      unique: column.unique,
      hasDefault: column.default !== undefined,
      check: column.check ?? null,
      references:
        column.references === undefined
          ? null
          : `${column.references.table}.${column.references.column}`,
    })),
    invariants: invariants.map((inv) => ({
      name: inv.name,
      kind: inv.kind,
      message: inv.message,
      sql: inv.sql,
      where: inv.where ?? null,
    })),
    indexes: init.table.indexes.map((index) => index.name),
    tags: [cacheTag, ...(init.tags ?? [])],
    cacheTag,
    softDelete,
    orgScoped,
  });

  const built: Entity<T, C> = {
    name,
    table: init.table,
    type: init.type,
    invariants,
    tags: [cacheTag, ...(init.tags ?? [])],
    cacheTag,
    softDelete,
    orgScoped,
    tagFor: (id) => `${cacheTag}:${id}`,
    parse: (value) => parseWith(init.type, name, value),
    assert: (row) => assertInvariants(name, invariants, row),
    migration: () => invariantsToSql(init.table.name, invariants),
    describe,
  };

  registerEntity({ name, tableName: init.table.name, describe });
  return built;
};
