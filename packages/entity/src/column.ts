// The chain every column builder is made of. Each link returns a new column, so a chain reads
// in declaration order and a builder is never mutated behind someone's back.
//
// Where a column landed (table, property key, physical name) is recorded in a binding rather
// than on the column: the author writes the property key once, `entity()` derives `orgId` ->
// `org_id` from it, and a lazy `.references(() => orgs.id)` can still resolve the target's
// physical name even though two schema modules import each other in a cycle.

import { invariantViolated } from './errors';
import { refuseColumn } from './refuse';
import type {
  AnyColumn,
  Column,
  ColumnDefault,
  ColumnMap,
  ColumnMeta,
  MoneyColumnNames,
  TimestampColumn,
} from './types';

/**
 * The column a NAME resolves to, or `undefined` — the ONE read of a column map by a name that came
 * from outside it.
 *
 * `columns[property]` alone walks `Object.prototype`: an app's column map is a plain object
 * literal, so `columns['constructor']` answers the `Object` FUNCTION, every `=== undefined` guard
 * downstream passes, and the next `.$meta.kind` is a bare `TypeError` where the caller was owed
 * `X_INVARIANT_VIOLATED` naming the columns that do exist. The name is caller data on every path
 * that reaches here — a predicate column, a sort key, an `onConflict` target, a `select` list — so
 * the discriminator lives in one place. Same read `tenancy.ts` already does for the tenant column.
 */
export const columnFor = (columns: ColumnMap, property: string): AnyColumn | undefined =>
  Object.hasOwn(columns, property) ? columns[property] : undefined;

export const snake = (value: string): string =>
  value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * The physical column, decided in ONE place: what `.column()` declared, else `snake(property)`.
 *
 * Every projection reads it here — the DDL, the binding, the decoder, the invariant resolver, the
 * index names — because a second `snake(property)` anywhere is a statement naming a column the
 * table does not have, and the first table that proves it is somebody's production database.
 */
export const columnName = (property: string, meta: ColumnMeta): string =>
  meta.name ?? snake(property);

/** Money's three physical columns, resolved. `scale: null` is a table that has no scale column. */
export interface MoneyColumns {
  readonly minor: string;
  readonly currency: string;
  readonly scale: string | null;
}

/**
 * Per part, merged over the `<base>_minor` / `<base>_currency` / `<base>_scale` defaults — so a
 * table that renamed one of the three does not have to restate the other two, and `.column()`
 * moves the base for all of them at once.
 */
export const moneyColumns = (property: string, meta: ColumnMeta): MoneyColumns => {
  const base = columnName(property, meta);
  const declared: MoneyColumnNames = meta.parts ?? {};
  return {
    minor: declared.minor ?? `${base}_minor`,
    currency: declared.currency ?? `${base}_currency`,
    // `undefined` takes the default; `null` is the caller saying the column is not there at all.
    scale: declared.scale === undefined ? `${base}_scale` : declared.scale,
  };
};

export const GENERATED_UUID: ColumnDefault = { kind: 'generated', by: 'uuid-v7' };
export const GENERATED_NOW: ColumnDefault = { kind: 'generated', by: 'now' };

/** Every column starts here: not null, no key, no index. */
export const BARE: Omit<ColumnMeta, 'kind'> = {
  notNull: true,
  primaryKey: false,
  unique: false,
  index: false,
  tenant: false,
};

export interface Binding {
  readonly table: string;
  /** camelCase key on the row. */
  readonly property: string;
  /** snake_case physical column name. */
  readonly name: string;
}

const bindings = new WeakMap<AnyColumn, Binding>();

/**
 * Called once per column by `entity()`. A column object belongs to exactly one table: sharing
 * one between two entities would give it two physical names and silently mis-name a foreign
 * key, so a second binding is a declaration-time error.
 */
export const bindColumn = (column: AnyColumn, table: string, property: string): Binding => {
  const existing = bindings.get(column);
  if (existing !== undefined && existing.table !== table) {
    throw invariantViolated(
      table,
      property,
      `this column is already bound to ${existing.table}.${existing.name}; ` +
        'build a new column instead of sharing one between entities',
    );
  }
  // The DERIVED name too, not only a declared one: `snake(property)` lower-cases and nothing else.
  const binding: Binding = {
    table,
    property,
    name: assertColumnName(columnName(property, column.$meta)),
  };
  bindings.set(column, binding);
  return binding;
};

export const bindingOf = (column: AnyColumn): Binding | undefined => bindings.get(column);

/**
 * A declared foreign key, resolved to where its target actually landed — `null` when the column
 * declares none. The thunk exists because two schema modules import each other in a cycle, so
 * this can only be answered after both have evaluated; it is answered in ONE place so the DDL
 * projection (`describe.ts`) and the relation map (`relations.ts`) can never disagree about what
 * a `references()` points at.
 */
export const referenceBinding = (
  entityName: string,
  property: string,
  meta: ColumnMeta,
): Binding | null => {
  if (meta.references === undefined) return null;
  const target = bindingOf(meta.references());
  if (target === undefined) {
    throw invariantViolated(
      entityName,
      property,
      'references a column that belongs to no entity — pass a column of an entity() result',
    );
  }
  return target;
};

const literal = (value: unknown): ColumnDefault => {
  if (value === null) return { kind: 'value', value: null };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'value', value };
  }
  return refuseColumn(
    'default',
    `a default must be a literal; got ${typeof value}`,
    ".default('draft'), .default(0) or .default(false) — a literal the DDL can carry; for an instant use timestamp().defaultNow(), and a computed default belongs in the insert",
  );
};

export const makeColumn = <T, Optional extends boolean>(
  meta: ColumnMeta,
  parse: (value: unknown) => T,
  optional: Optional,
): Column<T, Optional> => ({
  $meta: meta,
  $parse: parse,
  $optional: optional,

  primaryKey: () => {
    // Only a uuid key can be generated for the caller; any other key must be supplied.
    const generated = meta.kind === 'uuid' && meta.default === undefined;
    return makeColumn<T, boolean>(
      { ...meta, primaryKey: true, ...(generated ? { default: GENERATED_UUID } : {}) },
      parse,
      generated || meta.default !== undefined,
    );
  },

  nullable: () =>
    makeColumn<T | null, Optional>(
      { ...meta, notNull: false },
      (value) => (value === null || value === undefined ? null : parse(value)),
      optional,
    ),

  unique: () => makeColumn<T, Optional>({ ...meta, unique: true }, parse, optional),

  tenant: () => makeColumn<T, Optional>({ ...meta, tenant: true, index: true }, parse, optional),

  references: (target, options = {}) =>
    makeColumn<T, Optional>(
      {
        ...meta,
        references: target,
        index: true,
        ...(options.onDelete === undefined ? {} : { onDelete: options.onDelete }),
      },
      parse,
      optional,
    ),

  default: (value) => makeColumn<T, true>({ ...meta, default: literal(value) }, parse, true),

  column: (name) =>
    makeColumn<T, Optional>({ ...meta, name: assertColumnName(name) }, parse, optional),
});

/**
 * A physical name is spliced into DDL and into every statement as a quoted identifier, so it is
 * checked where it is written rather than trusted there: an empty name produces `""`, and a name
 * carrying a quote or a newline is the one value in a column declaration that could close the
 * identifier. `[a-z_][a-z0-9_$]*`, which is what an unquoted Postgres identifier may be, and the
 * bound is the same 63 bytes the server truncates at — a longer one silently addresses a
 * different column.
 *
 * **Every physical name, not only a declared one — `As of 2026-08-24`.** `columnName` is
 * `meta.name ?? snake(property)` and for three majors only the first branch reached here, so a
 * PROPERTY name went into the DDL untouched: `snake()` lower-cases and does nothing else, and a
 * column named `n" , "x" text); drop table t; --` produced a `create table` carrying a real
 * `drop table` (measured through `generateMigration`). Quoting is not a defence against a value
 * that can close the quote, which is what the paragraph above already said. `bindColumn` is where
 * the derived name is checked, because that runs once per column at `entity()` rather than on
 * every statement.
 */
export const assertColumnName = (name: string): string => {
  if (!/^[a-z_][a-z0-9_$]*$/.test(name) || name.length > 63) {
    refuseColumn(
      'column-name',
      `"${name}" is not a physical column name: lower-case letters, digits and underscores, at most 63 of them`,
      ".column('created_at') — lower-case letters, digits and underscores, at most 63 of them",
    );
  }
  return name;
};

export const column = <T>(
  kind: ColumnMeta['kind'],
  parse: (value: unknown) => T,
  extra: Partial<ColumnMeta> = {},
): Column<T> => makeColumn<T, false>({ ...BARE, ...extra, kind }, parse, false);

/**
 * `timestamptz`, always. There is no naive-timestamp builder and there will not be one: a
 * `timestamp without time zone` is a bug that only surfaces twice a year.
 */
export const makeTimestamp = <Optional extends boolean>(
  meta: ColumnMeta,
  parse: (value: unknown) => Date,
  optional: Optional,
): TimestampColumn<Optional> => ({
  ...makeColumn<Date, Optional>(meta, parse, optional),
  defaultNow: () => makeTimestamp({ ...meta, default: GENERATED_NOW }, parse, true),
  onUpdateNow: () => makeTimestamp({ ...meta, onUpdate: GENERATED_NOW }, parse, optional),
  // Overridden so `timestamp().column('created').defaultNow()` still has `defaultNow` — the
  // general link returns the general column, and a builder with methods of its own keeps them.
  column: (name) => makeTimestamp({ ...meta, name: assertColumnName(name) }, parse, optional),
});
