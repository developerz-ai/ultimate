// Single responsibility: read the live schema out of `information_schema` / `pg_catalog` into a
// plain, sortable description. Three consumers depend on this exact shape: drift detection, the
// generated admin dashboard's schema view, and the MCP `schema.describe` tool. Keep it JSON-safe
// and deterministically ordered — it is diffed and it is serialised.

import { type DbClient, db } from './client';
import { sql } from './sql';

export interface ColumnDescription {
  readonly name: string;
  /** Postgres type name as reported by the catalog (`text`, `timestamptz`, `numeric(12,2)`). */
  readonly dataType: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly position: number;
}

export interface IndexDescription {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly primary: boolean;
}

export interface ForeignKeyDescription {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly onDelete: string | null;
}

export interface TableDescription {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnDescription[];
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexDescription[];
  readonly foreignKeys: readonly ForeignKeyDescription[];
}

export interface SchemaDescription {
  readonly tables: readonly TableDescription[];
}

export interface IntrospectOptions {
  readonly client?: DbClient | undefined;
  readonly schema?: string | undefined;
  /** The ledger is framework bookkeeping, not user schema — excluded so it never reads as drift. */
  readonly exclude?: readonly string[] | undefined;
}

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
  readonly ordinal_position: number;
}

interface IndexRow {
  readonly table_name: string;
  readonly index_name: string;
  readonly is_unique: boolean;
  readonly is_primary: boolean;
  readonly columns: readonly string[];
}

interface ForeignKeyRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly columns: readonly string[];
  readonly referenced_table: string;
  readonly referenced_columns: readonly string[];
  readonly on_delete: string | null;
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1);

export async function introspect(options: IntrospectOptions = {}): Promise<SchemaDescription> {
  const client = options.client ?? db();
  const schema = options.schema ?? 'public';
  const excluded = options.exclude ?? ['x_migrations'];

  const columns = await client.query<ColumnRow>(sql`
    select table_name, column_name, data_type, is_nullable, column_default, ordinal_position
    from information_schema.columns
    where table_schema = ${schema}
    order by table_name, ordinal_position
  `);

  const indexes = await client.query<IndexRow>(sql`
    select
      t.relname as table_name,
      i.relname as index_name,
      ix.indisunique as is_unique,
      ix.indisprimary as is_primary,
      array_agg(a.attname order by a.attnum) as columns
    from pg_class t
    join pg_namespace n on n.oid = t.relnamespace
    join pg_index ix on ix.indrelid = t.oid
    join pg_class i on i.oid = ix.indexrelid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any(ix.indkey)
    where n.nspname = ${schema} and t.relkind = 'r'
    group by t.relname, i.relname, ix.indisunique, ix.indisprimary
    order by t.relname, i.relname
  `);

  const foreignKeys = await client.query<ForeignKeyRow>(sql`
    select
      src.relname as table_name,
      c.conname as constraint_name,
      array_agg(sa.attname order by sa.attnum) as columns,
      tgt.relname as referenced_table,
      array_agg(ta.attname order by ta.attnum) as referenced_columns,
      c.confdeltype as on_delete
    from pg_constraint c
    join pg_class src on src.oid = c.conrelid
    join pg_class tgt on tgt.oid = c.confrelid
    join pg_namespace n on n.oid = src.relnamespace
    join pg_attribute sa on sa.attrelid = src.oid and sa.attnum = any(c.conkey)
    join pg_attribute ta on ta.attrelid = tgt.oid and ta.attnum = any(c.confkey)
    where c.contype = 'f' and n.nspname = ${schema}
    group by src.relname, c.conname, tgt.relname, c.confdeltype
    order by src.relname, c.conname
  `);

  return buildSchema(schema, excluded, columns, indexes, foreignKeys);
}

/** Pure, so the row -> description mapping is testable without a database. */
export function buildSchema(
  schema: string,
  excluded: readonly string[],
  columns: readonly ColumnRow[],
  indexes: readonly IndexRow[],
  foreignKeys: readonly ForeignKeyRow[],
): SchemaDescription {
  const names = [...new Set(columns.map((row) => row.table_name))]
    .filter((name) => !excluded.includes(name))
    .sort();

  const tables = names.map((name): TableDescription => {
    const tableIndexes = indexes
      .filter((row) => row.table_name === name)
      .map((row) => ({
        name: row.index_name,
        columns: [...row.columns],
        unique: row.is_unique,
        primary: row.is_primary,
      }))
      .sort(byName);
    return {
      schema,
      name,
      columns: columns
        .filter((row) => row.table_name === name)
        .map((row) => ({
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.is_nullable === 'YES',
          default: row.column_default,
          position: row.ordinal_position,
        }))
        .sort(byName),
      primaryKey: tableIndexes.find((index) => index.primary)?.columns ?? [],
      indexes: tableIndexes,
      foreignKeys: foreignKeys
        .filter((row) => row.table_name === name)
        .map((row) => ({
          name: row.constraint_name,
          columns: [...row.columns],
          referencedTable: row.referenced_table,
          referencedColumns: [...row.referenced_columns],
          onDelete: row.on_delete,
        }))
        .sort(byName),
    };
  });

  return { tables };
}

export function findTable(schema: SchemaDescription, table: string): TableDescription | undefined {
  return schema.tables.find((candidate) => candidate.name === table);
}
