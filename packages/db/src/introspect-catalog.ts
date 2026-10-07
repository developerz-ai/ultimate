// Single responsibility: read the WHOLE schema out of `pg_catalog` — tables and everything that is
// not a table — into one `CatalogDescription`, sorted in JS. `introspectSchema()` beside it stays the
// entity-vocabulary reading drift compares to a snapshot; this is the catalog's own spelling, the
// input of the schema dump, and comparable only to another reading of itself.

import type { CatalogDescription, CatalogType } from './catalog';
import { by, sequenceOf, tableOf } from './catalog-fold';
import {
  domainCheckRows,
  domainRows,
  enumRows,
  extensionRows,
  functionRows,
  triggerRows,
  unrenderedRows,
  viewRows,
} from './catalog-objects';
import {
  columnRows,
  constraintRows,
  indexRows,
  sequenceRows,
  tableRows,
} from './catalog-relations';
import { type DbClient, db } from './client';

export interface IntrospectCatalogOptions {
  readonly client?: DbClient | undefined;
  readonly schema?: string | undefined;
}

async function typesOf(client: DbClient, schema: string): Promise<readonly CatalogType[]> {
  const labels = await enumRows(client, schema);
  const domains = await domainRows(client, schema);
  const checks = await domainCheckRows(client, schema);
  const enums = [...new Set(labels.map((row) => row.name))].map(
    (name): CatalogType => ({
      kind: 'enum',
      name,
      labels: labels
        .filter((row) => row.name === name)
        .sort((a, b) => a.position - b.position)
        .map((row) => row.label),
    }),
  );
  const described = domains.map(
    (row): CatalogType => ({
      kind: 'domain',
      name: row.name,
      baseType: row.base_type,
      notNull: row.not_null,
      default: row.expression,
      checks: checks
        .filter((check) => check.domain_name === row.name)
        .sort(by((check) => check.name))
        .map((check) => ({ name: check.name, definition: check.definition })),
    }),
  );
  return [...enums, ...described].sort(by((type) => type.name));
}

/**
 * Eleven round trips, sequential: a pinned transaction connection answers one statement at a
 * time, and this runs once per `x db gen`, never per request.
 */
export async function introspectCatalog(
  options: IntrospectCatalogOptions = {},
): Promise<CatalogDescription> {
  const client = options.client ?? db();
  const schema = options.schema ?? 'public';
  const tables = await tableRows(client, schema);
  const columns = await columnRows(client, schema);
  const constraints = await constraintRows(client, schema);
  const sequences = await sequenceRows(client, schema);
  const indexes = await indexRows(client, schema);
  const views = await viewRows(client, schema);
  const functions = await functionRows(client, schema);
  const triggers = await triggerRows(client, schema);
  const unrendered = await unrenderedRows(client, schema);
  const known = new Set(tables.map((table) => table.name));
  const materialized = new Set(views.filter((view) => view.kind === 'm').map((view) => view.name));
  // A trigger loads only onto a relation the dump creates: a plain table, or a view (`instead
  // of`). One on a partitioned table or a partition was filed under `09_triggers/` for a table no
  // file creates, and the load refused the whole dump with `X_SCHEMA_DUMP_DRIFT`.
  const viewNames = new Set(views.map((view) => view.name));
  const loadable = (trigger: { readonly table_name: string }): boolean =>
    known.has(trigger.table_name) || viewNames.has(trigger.table_name);

  return {
    schema,
    extensions: (await extensionRows(client))
      .map((row) => ({ name: row.name }))
      .sort(by((extension) => extension.name)),
    types: await typesOf(client, schema),
    sequences: sequences
      .filter((sequence) => sequence.ownership === null)
      .map(sequenceOf)
      .sort(by((sequence) => sequence.name)),
    tables: tables
      .map((table) => tableOf(table, columns, constraints, sequences))
      .sort(by((table) => table.name)),
    // An index on a relation this reading does not render (a partition) has nowhere to load.
    indexes: indexes
      .filter((index) => known.has(index.table_name) || materialized.has(index.table_name))
      .map((row) => ({ table: row.table_name, name: row.name, definition: row.definition }))
      .sort(
        by(
          (index) => index.table,
          (index) => index.name,
        ),
      ),
    foreignKeys: constraints
      .filter((constraint) => constraint.type === 'f' && known.has(constraint.table_name))
      .map((row) => ({ table: row.table_name, name: row.name, definition: row.definition }))
      .sort(
        by(
          (key) => key.table,
          (key) => key.name,
        ),
      ),
    views: views
      .map((row) => ({
        name: row.name,
        materialized: row.kind === 'm',
        options: row.options,
        definition: row.definition,
      }))
      .sort(by((view) => view.name)),
    functions: functions
      .map((row) => ({ name: row.name, arguments: row.arguments, definition: row.definition }))
      .sort(
        by(
          (fn) => fn.name,
          (fn) => fn.arguments,
        ),
      ),
    triggers: triggers
      .filter(loadable)
      .map((row) => ({
        table: row.table_name,
        name: row.name,
        definition: row.definition,
        enabled: row.enabled,
      }))
      .sort(
        by(
          (trigger) => trigger.table,
          (trigger) => trigger.name,
        ),
      ),
    unrendered: [
      ...unrendered,
      // Named rather than dropped, the rule `CatalogUnrendered` states.
      ...triggers
        .filter((trigger) => !loadable(trigger))
        .map((trigger) => ({
          kind: 'trigger',
          name: trigger.name,
          table_name: trigger.table_name,
        })),
    ]
      .map((row) => ({ kind: row.kind, name: row.name, table: row.table_name }))
      .sort(
        by(
          (object) => object.kind,
          (object) => object.table ?? '',
          (object) => object.name,
        ),
      ),
  };
}
