// `entity(name, { columns })` is the first primitive. The row type is DERIVED from the columns —
// there is no second declaration of the same shape to keep in sync — and everything downstream
// (the typed db handle, migrations, cache tags, the admin UI, the manifest) is projected from
// this one call.

import { renderThrowable } from '@ultimat3/core';
import type { IndexMethod } from '@ultimat3/db';
import { describeValue, type StandardSchemaV1 } from '@ultimat3/schema';
import { entityNow } from './clock';
import { assertColumnName, bindColumn, columnName, moneyColumns } from './column';
import { newId } from './columns';
import { describeEntity, describeReferences } from './describe';
import { invariantViolated } from './errors';
import type { Expr, InvariantColumns, Resolve } from './expr';
import { invariantColumns } from './expr';
import { indexName } from './index-name';
import type { Invariant, InvariantDef } from './invariants';
import { assertInvariants, bindInvariant, invariantsToSql } from './invariants';
import type { EntityDescription, ReferenceDescription } from './registry';
import { registerEntity } from './registry';
import type { SearchInit, SearchSource, SearchVector } from './search';
import { searchVectorOf } from './search';
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
  readonly where?: (columns: InvariantColumns<C>) => Expr;
  /**
   * The access method. Omitted is `btree`, which is Postgres' own default and what every index
   * declared before this existed is — so an entity that names none emits the statement it always
   * emitted and nothing regenerates.
   *
   * `'gin'` is the one with a caller, and it is the whole point of the containment operators:
   * measured on Postgres 16 over 20,000 rows, `tags @> …`, `tags <@ …`, `tags && …` and
   * `data @> …` are each a Bitmap Index Scan with one and a Seq Scan without. The set is
   * `@ultimat3/db`'s `INDEX_METHODS`, imported rather than restated — one declaration of one fact.
   *
   * Two Postgres rules ride with it and both are refused HERE, where the author is, rather than at
   * `x db gen` or inside `ROLE=migrate` as the server's own syntax error: a GIN index cannot be
   * unique and cannot order its keys.
   */
  readonly using?: IndexMethod;
}

export interface EntityInit<C extends ColumnMap> {
  readonly columns: C;
  /**
   * The physical table, when it is not the entity's own name. The half of adoption a column name
   * cannot cover: `entity('user', { table: 'users', … })` reads and writes the table that is
   * already there, and every statement, index name and foreign key follows it.
   *
   * The entity NAME stays the framework's key — the registry, the cache tag, `x entities describe`
   * and every relation are keyed by it — so renaming a table never moves a cache tag or a policy.
   */
  readonly table?: string;
  /**
   * The tenant column, said out loud. Omitted, it is inferred from `.tenant()` or a column named
   * `orgId`, so silence never means unscoped.
   */
  readonly tenant?: keyof C & string;
  /** Composite keys only — a single key is `uuid().primaryKey()` on the column itself. */
  readonly primaryKey?: readonly (keyof C & string)[];
  /**
   * A callback, not an array of `(c) => …` builders: the column proxy is typed from `C`, and `C`
   * is only fixed once for the whole `invariants` argument. Per-element builders were checked
   * before `C` existed, which is why `c.title` used to be `ColumnExpr | undefined`.
   */
  readonly invariants?: (columns: InvariantColumns<C>) => readonly InvariantDef[];
  readonly indexes?: readonly IndexInit<C>[];
  /**
   * Full-text search, when the two defaults do not fit: `search_tsv` and `'english'`. WHICH columns
   * are searched is `.searchable()` on the columns themselves, never restated here — this is the
   * adoption escape, exactly as `table` and `.column()` are.
   */
  readonly search?: SearchInit;
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
  /**
   * The generated `tsvector` this entity's `.searchable()` columns derive, or `null` when none is.
   * Presence is what makes `.search(text)` legal — both drivers read it, and neither invents one.
   */
  readonly $search: SearchVector | null;
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
  /**
   * The foreign keys this entity declares, resolved — one record per `references()`, both ends
   * named. The relation map reads it off the registry entry; a consumer holding the entity
   * itself reads it here. Same closure, so there is one reading of a foreign key, not two.
   */
  $references(): readonly ReferenceDescription[];
}

export type Entity<Row, C extends ColumnMap = ColumnMap> = EntityCore<Row, C> & C;

const MONEY_PARTS = new Set(['minor', 'currency']);

const defaultValue = (meta: ColumnMeta): unknown => {
  const declared = meta.default;
  if (declared === undefined) return undefined;
  if (declared.kind === 'value') return declared.value;
  return declared.by === 'uuid-v7' ? newId() : entityNow();
};

export const entity = <const C extends ColumnMap>(
  name: string,
  init: EntityInit<C>,
): Entity<RowOf<C>, C> => {
  type Row = RowOf<C>;
  const entries: readonly (readonly [string, AnyColumn])[] = Object.entries(init.columns);
  for (const [property, column] of entries) bindColumn(column, name, property);

  // Both branches. The declared table was checked and the fallback — which is every entity that
  // does not rename its table — was not, so an entity NAME closed the identifier in the same way a
  // column name could: `entity('t" (x int); drop table u; --')` emitted that `drop table` verbatim.
  const table = assertColumnName(init.table ?? name);
  const cacheTag = `entity:${name}`;
  const softDelete = Object.hasOwn(init.columns, SOFT_DELETE_COLUMN);
  const tenantColumn = resolveTenantColumn(name, init.columns, init.tenant);

  const searchSources: readonly SearchSource[] = entries.flatMap(([property, column]) => {
    const weight = column.$meta.searchable;
    return weight === undefined ? [] : [{ column: columnName(property, column.$meta), weight }];
  });
  const search = searchVectorOf(
    searchSources,
    init.search,
    // `physical`, not `candidate`: a parameter whose NAME reads like a credential is what
    // `bun run secret-compare` refuses an `===` on, and this is a column name.
    (physical) =>
      entries.some(([property, column]) => columnName(property, column.$meta) === physical),
    (subject, detail) => {
      throw invariantViolated(name, subject, detail);
    },
  );

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
      return columnName(property, column.$meta);
    }
    if (!isMoney || !MONEY_PARTS.has(part)) {
      throw invariantViolated(name, property, `${property} has no part "${part}"`);
    }
    const parts = moneyColumns(property, column.$meta);
    return part === 'minor' ? parts.minor : parts.currency;
  };

  const columnsExpr = invariantColumns<C>(
    name,
    entries.map(([property]) => property),
  );
  // Through the one resolver, so a soft-delete column the table spells differently is still the
  // column every partial index excludes rows by.
  const partialWhere = softDelete ? `${resolve([SOFT_DELETE_COLUMN])} is null` : undefined;
  // Called once, here, so an unknown column throws while the entity is being declared.
  const invariants: readonly Invariant<Row>[] = (init.invariants?.(columnsExpr) ?? []).map((def) =>
    bindInvariant<Row>(def, resolve, partialWhere),
  );

  const declared: readonly IndexDef[] = [
    ...entries.flatMap(([property, column]) => {
      const meta = column.$meta;
      if (!meta.unique && !meta.index) return [];
      const physical = [
        meta.kind === 'money' ? moneyColumns(property, meta).minor : columnName(property, meta),
      ];
      return [
        {
          name: indexName(name, table, physical, meta.unique),
          columns: physical,
          unique: meta.unique,
        },
      ];
    }),
    ...(init.indexes ?? []).map((index) => {
      const columns = index.on.map((property) => resolve([property]));
      const unique = index.unique === true;
      // `on: []` is type-legal and names nothing: the generated DDL would be `on "posts" ()`, a
      // syntax error one migration later. Refused where it was written instead.
      if (columns.length === 0) {
        throw invariantViolated(name, 'index', 'an index must name at least one column');
      }
      const where = index.where?.(columnsExpr).toSql(resolve) ?? null;
      if (index.where !== undefined && where === null) {
        throw invariantViolated(
          name,
          'index',
          'a partial index predicate must be expressible in SQL; a JS predicate cannot be one',
        );
      }
      // Two rules Postgres has that a declaration can break, refused where the author wrote it.
      // `@ultimat3/db` refuses both again at `createIndex` — that is not a duplicate, it is the
      // guard for a description nobody built here — but its refusal lands at `x db gen` or, if a
      // migration was already written, inside `ROLE=migrate` as the server's own syntax error with
      // none of the entity's words in it.
      if (index.using !== undefined && index.using !== 'btree') {
        if (unique) {
          throw invariantViolated(
            name,
            'index',
            `the index on (${columns.join(', ')}) is unique and ${index.using}; ` +
              `Postgres has no unique ${index.using} index — drop unique, or drop using`,
          );
        }
        if (index.order !== undefined) {
          throw invariantViolated(
            name,
            'index',
            `the index on (${columns.join(', ')}) is ${index.using} and ${index.order}; ` +
              'only a btree orders its keys — drop order, or drop using',
          );
        }
      }
      return {
        name: indexName(name, table, columns, unique, index.order, where, index.using),
        columns,
        unique,
        ...(index.order === undefined ? {} : { order: index.order }),
        ...(where === null ? {} : { where }),
        // Absent stays absent: `btree` written out would be a field every existing snapshot lacks,
        // and `indexMethodOf` reads the two the same way precisely so nothing regenerates.
        ...(index.using === undefined || index.using === 'btree' ? {} : { using: index.using }),
      };
    }),
    // The one index nobody declared and every search needs. Through the SAME `IndexInit` path a
    // hand-written `using: 'gin'` takes — `indexName` gives it the method discriminator, so it can
    // never collide with a btree an author declares on the same column.
    ...(search === null
      ? []
      : [
          {
            name: indexName(name, table, [search.column], false, undefined, null, 'gin'),
            columns: [search.column],
            unique: false,
            using: 'gin' as IndexMethod,
          },
        ]),
  ];
  /**
   * A foreign key already indexes its column; naming it again in `indexes` is not two indexes.
   *
   * On the WHOLE definition and not on the name. With the discriminator above the two rules agree
   * exactly, so this is not a behaviour change on its own — it is which one FAILS LOUDLY if the
   * naming is ever weakened again. Matching on the name drops the second index in silence, which
   * is how two different partial indexes became one for three majors; matching on the definition
   * keeps both, and two `create index` statements sharing a name is `42P07` on the next migration.
   */
  const identity = (index: IndexDef): string =>
    [
      index.name,
      index.columns.join(','),
      index.unique,
      index.order ?? '',
      index.where ?? '',
      index.using ?? '',
    ].join('|');
  const indexes: readonly IndexDef[] = declared.filter(
    (index, position) =>
      declared.findIndex((other) => identity(other) === identity(index)) === position,
  );

  const tags = [cacheTag, ...(init.tags ?? [])];
  const describe = (): EntityDescription =>
    describeEntity({
      name,
      table,
      columns: entries,
      primaryKey,
      invariants,
      indexes,
      tags,
      cacheTag,
      softDelete,
      tenantColumn,
      search,
    });
  const references = (): readonly ReferenceDescription[] => describeReferences(name, entries);

  const parse = (value: unknown): Row => {
    if (typeof value !== 'object' || value === null) {
      // `describeValue`, never `String(value)`: this message is a `$parse` failure, which reaches
      // the caller and the log line — and the whole row is the last value in the framework that
      // may be echoed there. Same renderer as the column builders (`columns.ts`) use.
      throw invariantViolated(name, 'row', `expected an object, got ${describeValue(value)}`);
    }
    const input = value as Readonly<Record<string, unknown>>;
    const row: Record<string, unknown> = {};
    for (const [property, column] of entries) {
      // `=== undefined`, never `??`: an explicit `null` is the caller CLEARING a nullable column,
      // and `??` read it as absence and wrote the column's declared default straight back — so
      // `update(id, { status: null })` reported success and stored `'draft'`, with nothing on any
      // surface to say otherwise. A present `undefined` still means absence, which is what a
      // spread of an omitted optional key produces and is the shape every existing caller has.
      const raw = input[property];
      const given = raw === undefined ? defaultValue(column.$meta) : raw;
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
    $table: table,
    $columns: init.columns,
    $primaryKey: primaryKey,
    $indexes: indexes,
    $invariants: invariants,
    $tags: tags,
    $cacheTag: cacheTag,
    $softDelete: softDelete,
    $tenantColumn: tenantColumn,
    $search: search,
    $schema: {
      '~standard': {
        version: 1,
        vendor: 'ultimate',
        validate: (value) => {
          try {
            return { value: parse(value) };
          } catch (error) {
            // `renderThrowable`, never `error instanceof Error ? error.message : String(error)`:
            // both halves of that read the caught value directly. `instanceof` consults
            // `getPrototypeOf` and `String()` runs the value's own coercion, so a `Proxy` or a
            // null-prototype throwable raised a SECOND, uncatchable `TypeError` out of the
            // validator — where a rejection belongs. A column parser is app-reachable and an
            // app's `$parse` may throw anything at all.
            return { issues: [{ message: renderThrowable(error) }] };
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
    $references: references,
  };

  registerEntity({ name, tableName: table, describe, references });
  // The columns land on the entity itself so `orgs.id` is a column reference; every framework
  // member is `$`-prefixed, which is why a column may be called `name`.
  return Object.assign(core, init.columns);
};
