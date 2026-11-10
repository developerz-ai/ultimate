// `entity(name, { columns })` is the first primitive. The row type is DERIVED from the columns —
// there is no second declaration of the same shape to keep in sync — and everything downstream
// (the typed db handle, migrations, cache tags, the admin UI, the manifest) is projected from
// this one call.

import type { IndexMethod } from '@ultimat3/db';
import type { Schema } from '@ultimat3/schema';
import { assertAppendOnlyColumns } from './append-only';
import { assertTableName, bindColumn, columnName, moneyColumns } from './column';
import { declaredIndexOf } from './declared-index';
import {
  assertNotRetired,
  assertScan,
  assertShared,
  describeEntity,
  describeReferences,
} from './describe';
import { rowParsers } from './entity-parse';
import { parseEntityPatch } from './entity-patch';
import { invariantViolated } from './errors';
import type { InvariantColumns, Resolve } from './expr';
import { invariantColumns } from './expr';
import type { HistoryEntity, HistoryInit } from './history';
import { distinctIndexes } from './index-identity';
import type { IndexInit } from './index-init';
import { indexName } from './index-name';
import type { Invariant, InvariantDef } from './invariants';
import { assertInvariants, bindInvariant } from './invariants';
import { describeLifecycle, lifecycleHistory } from './lifecycle';
import { type PartitionInit, partitionOf } from './partition';
import { assertReadOnly } from './read-only';
import { recordProjection } from './record-projection';
import type { EntityDescription, ReferenceDescription } from './registry';
import { registerEntity } from './registry';
import { type Retain, type RetainInit, retainOf } from './retain';
import { rowSchema } from './row-schema';
import { sealedFields } from './sealed';
import { assertSealedDeclaration } from './sealed-declaration';
import { sealedInView } from './sealed-errors';
import type { SearchInit, SearchSource, SearchVector } from './search';
import { searchVectorOf } from './search';
import { resolveTenantColumn } from './tenancy';
import { coveredByTenantIndex, tenantIndexOf, withoutDerivedDuplicate } from './tenant-index';
import type { AnyColumn, ColumnMap, IndexDef, RowOf, WireRow } from './types';
import type { EntityView } from './view';
import { viewFor } from './view';
import { type ViewInit, type ViewQuery, viewQueryOf } from './view-entity';

/** Presence of this column is what makes an entity soft-deletable — not a flag. */
export const SOFT_DELETE_COLUMN = 'deletedAt';

export interface EntityInit<C extends ColumnMap> {
  readonly columns: C;
  /**
   * The physical table, when it is not the entity's own name. The half of adoption a column name
   * cannot cover: `entity('user', { table: 'users', … })` reads and writes the table that is
   * already there, and every statement, index name and foreign key follows it.
   *
   * The entity NAME stays the framework's key — the registry, the cache tag, `x entities show`
   * and every relation are keyed by it — so renaming a table never moves a cache tag or a policy.
   */
  readonly table?: string;
  /**
   * The tenant column, said out loud. Omitted, it is inferred from `.tenant()` or a column named
   * `orgId`, so silence never means unscoped.
   */
  readonly tenant?: keyof C & string;
  /**
   * Why an entity with no tenant column, referencing a tenant-owned one, belongs to no tenant.
   * Without it `x verify`'s exercise step reports `X_ENTITY_TENANT_UNDECLARED`; blank is refused.
   */
  readonly shared?: string;
  /**
   * Why this table may be read by a sequential scan: a closed catalog that stays a handful of rows.
   * Without it `x verify`'s exercise step reports a statement no index serves (`X_QUERY_UNINDEXED`)
   * and a reference column no index leads with; blank is refused.
   */
  readonly scan?: string;
  /**
   * Why the app never writes this table — legacy history a trigger closed, a table another system
   * owns. Every write is `X_ENTITY_READ_ONLY` and `x exercise` seeds no row of it; blank is refused.
   */
  readonly readOnly?: string;
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
  /**
   * Whether a browser keeps this entity's records on disk (IndexedDB, keyed by principal) so they
   * survive a reload and an offline start. Default `false`: a record is private data by default,
   * and disk is a decision. Read off `recordProjection(entity).persist` by realtime's persister.
   */
  readonly persist?: boolean;
  /**
   * Rows are written once and never changed or removed — a ledger, an audit trail, an event log.
   * The repository refuses every rewrite (`append-only.ts`) and `x db gen` emits the trigger that
   * refuses the same in raw SQL. A soft-delete, `onUpdateNow()` or state-machine column is refused.
   */
  readonly appendOnly?: boolean;
  /**
   * Physical columns the previous release still reads and this one does not: a rolling deploy's
   * first half of a column drop. Delete the column from `columns` and name it here, so it leaves
   * the row type, the projection and every insert while `x db gen` writes a marker and keeps it.
   * Remove it from this list in the next release, and `x db gen --allow-destructive` drops it. A
   * name, not a chain on the column: a column here has no builder left to chain from.
   */
  readonly retired?: readonly string[];
  /**
   * A relation Postgres derives rather than a table: `x db gen` emits `create [materialized] view`
   * from `sql`, reads are the chain's (tenancy, codec, `$view`), and every write is
   * `X_ENTITY_VIEW_READ_ONLY`. `columns` name its output columns; `primaryKey` is the read identity.
   */
  readonly view?: ViewInit;
  /** Rows older than `after` by `on` are swept by `purge({ entities: 'declared' })` (`retain.ts`). */
  readonly retain?: RetainInit<keyof C & string>;
  /** Every row change recorded into `<table>_history` by trigger (`history.ts`, `$history`). */
  readonly history?: HistoryInit;
  /**
   * Range-partitioned by a `timestamp()`/`date()` in the primary key, one partition per `interval`
   * (`partition.ts`). `x db gen` writes `partition by range` and the first partitions; a scheduled
   * maintenance run creates `ahead` more and drops what `retain` expired. Never beside `retain`.
   */
  readonly partitionBy?: PartitionInit<keyof C & string>;
  /** Set by `history.ts` on the history entity it declares: the parent's name. Never by hand. */
  readonly historyOf?: string;
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
  /** `entity({ appendOnly: true })`: update and delete are refused, here and by the table. */
  readonly $appendOnly: boolean;
  /** `entity({ retain })`, checked; `null` when rows are kept. */
  readonly $retain: Retain | null;
  /** `entity({ history: true })`: the history entity, registered beside this one; else `null`. */
  readonly $history: HistoryEntity | null;
  /** On a history entity, its parent's name; `null` everywhere else. */
  readonly $historyOf: string | null;
  /** `entity({ view })`: the query a view is derived by, `null` on a table. Writes are refused. */
  readonly $viewQuery: ViewQuery | null;
  /** `entity({ readOnly })`'s reason, `null` on a table the app writes. Writes are refused. */
  readonly $readOnly: string | null;
  /** Property key of the tenant column, or `null`. Presence is what turns tenancy on. */
  readonly $tenantColumn: string | null;
  /**
   * The generated `tsvector` this entity's `.searchable()` columns derive, or `null` when none is.
   * Presence is what makes `.search(text)` legal — both drivers read it, and neither invents one.
   */
  readonly $search: SearchVector | null;
  /** Phantom: `type Post = typeof posts.$row`. Reading it at runtime throws. */
  readonly $row: Row;
  /**
   * The whole row as a `t` schema — forms and actions hand input to it, and an output naming it
   * (bare or wrapped: `t.array(posts.$schema)`) is a row the client store adopts, because its node
   * carries the `recordProjection` brand. A `$view` or a `.pick()` carries none: a partial row is
   * never a record.
   *
   * Typed `unknown` HERE and precisely on `Entity`: the parsed value is the row WITHOUT its sealed
   * columns (`WireRow`), which is not `Row`, and a conditional over `C` in this interface would
   * stop every `EntityCore<Row, C>` being an `EntityCore<Row>`. A row-agnostic consumer never read
   * the output type; the one that does holds the `entity()` result.
   */
  readonly $schema: Schema<unknown, unknown>;
  /** `entity:<name>:<id>` — row-level invalidation for live queries. */
  $tagFor(id: string): string;
  /** Fills declared defaults, then validates every column. Throws on a bad value. */
  $parse(value: unknown): Row;
  /** `$parse` for the columns a patch names: no default fills an absent one. `entity-patch.ts`. */
  $parsePatch<Patch>(patch: Patch): Patch;
  /**
   * `const PostView = posts.$view(['id', 'title'])` — the projection an action names as its
   * `output`. An unknown key is a compile error, and a declaration error for a JS caller.
   */
  $view<K extends keyof Row & string>(keys: readonly K[]): EntityView<Row, K>;
  /** Runs every invariant. Called by the repository on insert and update. */
  $assert(row: Row): void;
  // No `$migration()`. The CHECK/UNIQUE statements an entity contributes are `@ultimat3/db`'s to
  // render, off `$describe()`, beside the columns, indexes and foreign keys they have to be
  // ordered against — a fragment of a migration is not one, and the one here named the wrong
  // relation for three majors because nothing but its own test ever read it.
  $describe(): EntityDescription;
  /**
   * The foreign keys this entity declares, resolved — one record per `references()`, both ends
   * named. The relation map reads it off the registry entry; a consumer holding the entity
   * itself reads it here. Same closure, so there is one reading of a foreign key, not two.
   */
  $references(): readonly ReferenceDescription[];
}

/**
 * What `entity()` returns. `$schema` is restated with its real output: the row as it leaves the
 * server, without the sealed columns — so `output: users.$schema` types a client that cannot read
 * `password`, which is the value it will not be sent. `$parse` and `$row` are the whole row.
 */
export type Entity<Row, C extends ColumnMap = ColumnMap> = Omit<EntityCore<Row, C>, '$schema'> & {
  readonly $schema: Schema<unknown, WireRow<Row, C>>;
} & C;

const MONEY_PARTS = new Set(['minor', 'currency']);

export const entity = <const C extends ColumnMap>(
  name: string,
  init: EntityInit<C>,
): Entity<RowOf<C>, C> => {
  type Row = RowOf<C>;
  const entries: readonly (readonly [string, AnyColumn])[] = Object.entries(init.columns);
  // Resolved before the bindings, because a binding carries the tenant's PHYSICAL column: a
  // `references()` on another entity reads it through this column's binding at describe time.
  const tenantColumn = resolveTenantColumn(name, init.columns, init.tenant);
  const tenantMeta = tenantColumn === null ? undefined : init.columns[tenantColumn]?.$meta;
  const tenant = tenantMeta === undefined ? null : columnName(tenantColumn ?? '', tenantMeta);

  // Both branches. The declared table was checked and the fallback — which is every entity that
  // does not rename its table — was not, so an entity NAME closed the identifier in the same way a
  // column name could: `entity('t" (x int); drop table u; --')` emitted that `drop table` verbatim.
  const table = assertTableName(name, init.table ?? name);
  assertShared(name, table, init.shared, tenantColumn);
  assertScan(name, init.scan);
  for (const [property, column] of entries) bindColumn(column, name, property, tenant, table);
  const cacheTag = `entity:${name}`;
  const softDelete = Object.hasOwn(init.columns, SOFT_DELETE_COLUMN);
  const appendOnly = init.appendOnly === true;
  if (appendOnly) assertAppendOnlyColumns(name, entries, SOFT_DELETE_COLUMN);
  const readOnly = assertReadOnly(name, init.readOnly, { appendOnly, view: init.view != null });

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

  const columnsExpr = invariantColumns<C>(name, init.columns);
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
      if (coveredByTenantIndex(physical[0] ?? '', tenant, meta.unique)) return [];
      return [
        {
          name: indexName(name, table, physical, meta.unique),
          columns: physical,
          unique: meta.unique,
        },
      ];
    }),
    ...(init.indexes ?? []).map((index) =>
      declaredIndexOf(index, { name, table, resolve, columns: columnsExpr }),
    ),
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
  // After every other index, so one that already starts with `(tenant, pk)` is seen (`tenant-index.ts`).
  const physicalKey = primaryKey.map((property) => resolve([property]));
  const [tenantIndex] = tenantIndexOf({
    entityName: name,
    table,
    tenant,
    primaryKey: physicalKey,
    plainView: init.view != null && init.view.materialized !== true,
    covering: [
      ...declared.filter((index) => index.where == null && index.using === undefined),
      ...invariants.filter((inv) => inv.kind === 'unique' && inv.where == null),
    ].map((each) => each.columns),
  });
  // A foreign key's own index named again in `indexes` is one index, not two (`index-identity.ts`).
  const indexes = distinctIndexes(
    tenantIndex === undefined ? declared : [...declared, tenantIndex],
  );

  const retain = retainOf(name, init.retain, entries, indexes, appendOnly);
  const partition = partitionOf(name, init.partitionBy, {
    table,
    columns: entries,
    primaryKey,
    indexes,
    uniques: invariants.filter((inv) => inv.kind === 'unique').map((inv) => inv.columns),
    retain: init.retain !== undefined,
    view: init.view != null,
  });
  const sealed = sealedFields({ $name: name, $table: table, $columns: init.columns });
  assertSealedDeclaration({
    name,
    fields: sealed,
    primaryKey,
    tenantColumn,
    indexes,
    invariants,
  });
  const sealedKeys = new Set(sealed.map((field) => field.property));
  const viewQuery = viewQueryOf(name, init.view, {
    appendOnly,
    indexes,
    sealed: [...sealedKeys],
  });
  /** The columns that leave the server: every one that is not sealed. */
  const wireEntries = entries.filter(([property]) => !sealedKeys.has(property));

  const tags = [cacheTag, ...(init.tags ?? [])];
  const describe = (): EntityDescription =>
    describeEntity({
      name,
      table,
      columns: entries,
      primaryKey,
      invariants,
      indexes: withoutDerivedDuplicate(table, physicalKey, tenantIndex, indexes),
      tags,
      cacheTag,
      softDelete,
      tenantColumn,
      search,
      appendOnly,
      retired: init.retired,
      shared: init.shared,
      scan: init.scan,
      readOnly: init.readOnly,
      view: viewQuery,
      lifecycle: describeLifecycle(core as EntityCore, retain, init.historyOf),
      partition,
    });
  assertNotRetired(name, entries, init.retired);
  const references = (): readonly ReferenceDescription[] => describeReferences(name, entries);

  const { parse, parseWire } = rowParsers<Row, WireRow<Row, C>>(name, entries, sealedKeys);

  const schema = rowSchema<WireRow<Row, C>>(
    { name, table, primaryKey, persist: init.persist === true, sealed: [...sealedKeys] },
    wireEntries,
    parseWire,
  );

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
    $appendOnly: appendOnly || init.historyOf !== undefined,
    $viewQuery: viewQuery,
    $readOnly: readOnly,
    $tenantColumn: tenantColumn,
    $search: search,
    $schema: schema,
    get $row(): Row {
      // Type-only. Reading it means someone expected a value where a type was meant.
      throw invariantViolated(name, '$row', '$row is a type, not a value — use typeof x.$row');
    },
    $tagFor: (id) => `${cacheTag}:${id}`,
    $parse: parse,
    $parsePatch: (patch) => parseEntityPatch(name, init.columns, patch),
    $view: <K extends keyof Row & string>(keys: readonly K[]) => {
      // Before the view exists: a view is an `output`, and a sealed column is in none.
      const named = keys.find((key) => sealedKeys.has(key));
      if (named !== undefined) throw sealedInView(name, named);
      return viewFor<Row, K>(name, init.columns, keys);
    },
    $assert: (row) => assertInvariants(name, invariants, row),
    $describe: describe,
    $references: references,
    $retain: retain,
    // Assigned below, once this entity is registered: the history entity is declared after it.
    $history: null,
    // A history table is append-only to every repository: its rows are its trigger's to write.
    $historyOf: init.historyOf ?? null,
  };

  registerEntity({
    name,
    tableName: table,
    persist: init.persist === true,
    projection: recordProjection(core),
    core: core as EntityCore<unknown>,
    describe,
    references,
  });
  const { history, historyOf } = init;
  const lifecycle = { name, table, columns: init.columns, primaryKey, tenantColumn, appendOnly };
  const historyEntity = lifecycleHistory({ ...lifecycle, history, historyOf });
  if (historyEntity !== null) Object.assign(core, { $history: historyEntity });
  // The columns land on the entity itself so `orgs.id` is a column reference; every framework
  // member is `$`-prefixed, which is why a column may be called `name`.
  // `$schema` is restated so the result carries its real output type; it is the same object.
  return Object.assign(core, init.columns, { $schema: schema });
};
