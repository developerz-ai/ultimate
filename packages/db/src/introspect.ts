// Single responsibility: read the live schema out of `information_schema` / `pg_catalog` into a
// plain, sortable description — app tables only, never a relation an extension owns and never a
// view (`app-relation.ts`). `checkDrift` is its one shipped consumer, so what it omits a deploy
// cannot refuse over. Keep it JSON-safe and deterministically ordered: it is diffed and serialised.

import { nonAppRelations } from './app-relation';
import { type DbClient, db } from './client';
import { sql } from './sql';

export interface ColumnDescription {
  readonly name: string;
  /** Postgres type name as reported by the catalog (`text`, `timestamptz`, `numeric(12,2)`). */
  readonly dataType: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly position: number;
  /**
   * The generation expression, as the SNAPSHOT spells it. Absent for an ordinary column and absent
   * for every row this module reads out of the live catalog — deliberately: Postgres stores its own
   * rewriting of the expression (`COALESCE(title, ''::text)` for `coalesce("title", '')`), so a
   * catalog value could never compare equal to a generated one, and drift would report a correct
   * database forever. Both sides of the diff that DOES read it — `x db gen`'s — are generated
   * spellings, which is the same rule `IndexDescription.where` states one field down.
   */
  readonly generated?: string | undefined;
}

export interface IndexDescription {
  readonly name: string;
  /** Physical columns in **index key order** — the order the planner sorts by, never `attnum`. */
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly primary: boolean;
  /**
   * Partial index predicate as SQL, `null` when the index covers every row. The catalog returns
   * its own rewriting of the expression (`(deleted_at IS NULL)`), never the author's spelling, so
   * this is readable and comparable to *itself* — never to a snapshot's text. See `drift.ts`.
   */
  readonly where: string | null;
  /** `desc` only when every key column is descending; `null` is Postgres' own default. */
  readonly order: 'asc' | 'desc' | null;
  /**
   * The access method as `pg_am` names it — `btree`, `gin`, `gist`, or an extension's own. Read
   * OPEN rather than as the closed set an entity may declare: the live side is whatever the
   * catalog said, and a `gist` folded into `btree` is the difference drift exists to report.
   * Absent means `btree` — a snapshot written before this field existed carries no method, and
   * every index it recorded was one. `indexMethodOf()` is the one reader of that rule.
   */
  readonly using?: string | undefined;
}

export interface ForeignKeyDescription {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly onDelete: string | null;
}

/**
 * A named CHECK constraint, as the SNAPSHOT spells it — an entity invariant of kind `check`.
 *
 * Absent from every row this module reads out of the live catalog, deliberately and for the reason
 * `ColumnDescription.generated` gives one field up: `pg_get_constraintdef` answers Postgres' own
 * rewriting of the expression, so a catalog value could never compare equal to a generated one and
 * drift would report a correct database forever. The diff that DOES read it is `x db gen`'s, where
 * both sides are this generator's own spellings.
 */
export interface CheckDescription {
  readonly name: string;
  /** The predicate, exactly as the entity's invariant spells it. */
  readonly expression: string;
}

export interface TableDescription {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnDescription[];
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexDescription[];
  readonly foreignKeys: readonly ForeignKeyDescription[];
  /**
   * The CHECK constraints migrations declare. Absent — never `[]` — on a table that declares none
   * and in every sidecar written before this field existed, matching `IndexDescription.using`: a
   * snapshot that predates it must read as "nothing recorded" so the next `x db gen` emits the
   * `add constraint` the database is genuinely missing, rather than as "recorded none", which
   * would leave every already-generated app's invariants unenforced forever.
   */
  readonly checks?: readonly CheckDescription[] | undefined;
  /**
   * The catalog's half of `checks`, and a **separate field rather than the same one** — names
   * only, `conname` for `contype = 'c'`, never a definition.
   *
   * The two readings cannot share `checks` because they are not the same value. A catalog read
   * carries Postgres' own rewriting of the predicate and a declaration carries this generator's
   * spelling, so a `checks` filled from `pg_constraint` would put a rewritten expression on the
   * field `checkPlan` diffs against a generated one — every regenerated migration would then drop
   * and re-add every constraint in the app, forever, because the two strings can never be equal.
   * Splitting them means the type says which reading a value came from, and `checkPlan` cannot be
   * handed a catalog value by accident.
   *
   * `snapshotOf` never writes it and `parseSnapshot` never reads it, so a sidecar carries `checks`
   * alone. `introspect()` always answers with it, `[]` included: absent therefore means "nobody
   * asked the catalog", which is what keeps `compareChecks` silent on a description that never
   * read one instead of reporting every declared constraint as missing.
   */
  readonly checkNames?: readonly string[] | undefined;
}

export interface SchemaDescription {
  readonly tables: readonly TableDescription[];
}

export interface IntrospectOptions {
  readonly client?: DbClient | undefined;
  readonly schema?: string | undefined;
  /**
   * The ledger is framework bookkeeping, not user schema — excluded so it never reads as drift.
   *
   * Replaces the default (`['x_migrations']`) rather than adding to it. It never replaces the set
   * `nonAppRelations()` derives: an extension's relations are not app schema in any deployment,
   * so that exclusion is not a caller's to switch off.
   */
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
  readonly predicate: string | null;
  readonly descending: boolean;
  readonly method?: string | undefined;
}

interface ForeignKeyRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly columns: readonly string[];
  readonly referenced_table: string;
  readonly referenced_columns: readonly string[];
  readonly on_delete: string | null;
}

/** A CHECK constraint's NAME. There is deliberately no column for its definition — see `checkNames`. */
interface CheckRow {
  readonly table_name: string;
  readonly constraint_name: string;
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : 1);

export async function introspect(options: IntrospectOptions = {}): Promise<SchemaDescription> {
  const client = options.client ?? db();
  const schema = options.schema ?? 'public';
  // Asked first, and unconditionally: everything below reads `information_schema`, which admits a
  // view and an extension's own tables alongside the app's. Merged into `excluded` rather than
  // filtered afterwards so one deny list feeds the whole fold.
  const excluded = [
    ...(options.exclude ?? ['x_migrations']),
    ...(await nonAppRelations(client, schema)),
  ];

  const columns = await client.query<ColumnRow>(sql`
    select table_name, column_name, data_type, is_nullable, column_default, ordinal_position
    from information_schema.columns
    where table_schema = ${schema}
    order by table_name, ordinal_position
  `);

  // Ordered by the index's own key position, never by `attnum`: `indkey` IS the order the planner
  // sorts by, and a composite index on `(created_at, org_id)` whose columns were declared the
  // other way round came back reversed — a description that reads correct and compares wrong.
  // `indnkeyatts` drops INCLUDE payload columns, which are stored, not keyed.
  const indexes = await client.query<IndexRow>(sql`
    select
      t.relname as table_name,
      i.relname as index_name,
      ix.indisunique as is_unique,
      ix.indisprimary as is_primary,
      pg_get_expr(ix.indpred, ix.indrelid) as predicate,
      am.amname as method,
      array_agg(a.attname order by k.ord) as columns,
      bool_and((ix.indoption[k.ord - 1] & 1) = 1) as descending
    from pg_class t
    join pg_namespace n on n.oid = t.relnamespace
    join pg_index ix on ix.indrelid = t.oid
    join pg_class i on i.oid = ix.indexrelid
    join pg_am am on am.oid = i.relam
    cross join lateral unnest(ix.indkey::smallint[]) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
    where n.nspname = ${schema} and t.relkind = 'r' and k.ord <= ix.indnkeyatts
    group by t.relname, i.relname, ix.indisunique, ix.indisprimary, ix.indpred, ix.indrelid, am.amname
    order by t.relname, i.relname
  `);

  // `conkey` and `confkey` are unnested TOGETHER, by shared ordinality: they are two halves of one
  // ordered pairing, and matching each independently with `= any(...)` is a cross product — a
  // two-column key came back as four source columns against four referenced ones, duplicated and
  // misaligned. Ordered by `k.ord` (the constraint's own key position), never by `attnum`, for the
  // same reason `indkey` orders the index query: `references t (y, x)` is not `references t (x, y)`.
  const foreignKeys = await client.query<ForeignKeyRow>(sql`
    select
      src.relname as table_name,
      c.conname as constraint_name,
      array_agg(sa.attname order by k.ord) as columns,
      tgt.relname as referenced_table,
      array_agg(ta.attname order by k.ord) as referenced_columns,
      c.confdeltype as on_delete
    from pg_constraint c
    join pg_class src on src.oid = c.conrelid
    join pg_class tgt on tgt.oid = c.confrelid
    join pg_namespace n on n.oid = src.relnamespace
    cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(src_attnum, tgt_attnum, ord)
    join pg_attribute sa on sa.attrelid = src.oid and sa.attnum = k.src_attnum
    join pg_attribute ta on ta.attrelid = tgt.oid and ta.attnum = k.tgt_attnum
    where c.contype = 'f' and n.nspname = ${schema}
    group by src.relname, c.conname, tgt.relname, c.confdeltype
    order by src.relname, c.conname
  `);

  // `conname` and nothing else. `pg_get_constraintdef(c.oid)` is one word further along this line
  // and is the reason this query did not exist: it answers Postgres' rewriting of the predicate,
  // which no generated spelling can ever equal, so reading it would make every drift check report
  // a correct database as wrong. `contype = 'c'` is the CHECK constraints alone — Postgres 17
  // onwards records a NOT NULL as `'n'`, and a domain's as `'c'` on the domain rather than here.
  const checks = await client.query<CheckRow>(sql`
    select src.relname as table_name, c.conname as constraint_name
    from pg_constraint c
    join pg_class src on src.oid = c.conrelid
    join pg_namespace n on n.oid = src.relnamespace
    where c.contype = 'c' and n.nspname = ${schema} and src.relkind = 'r'
    order by src.relname, c.conname
  `);

  return buildSchema(schema, excluded, columns, indexes, foreignKeys, checks);
}

/** Pure, so the row -> description mapping is testable without a database. */
export function buildSchema(
  schema: string,
  excluded: readonly string[],
  columns: readonly ColumnRow[],
  indexes: readonly IndexRow[],
  foreignKeys: readonly ForeignKeyRow[],
  checks: readonly CheckRow[] = [],
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
        where: row.predicate,
        order: row.descending ? ('desc' as const) : null,
        // `exactOptionalPropertyTypes`: a row with no method is a stub's, and absent must stay
        // absent rather than becoming an explicit `undefined` a strict comparison can see.
        ...(row.method === undefined ? {} : { using: row.method }),
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
      // Always written, `[]` included: this reading of a table HAS asked the catalog, and absence
      // is reserved for a description that has not (`compareChecks` is silent on that one).
      checkNames: checks
        .filter((row) => row.table_name === name)
        .map((row) => row.constraint_name)
        .sort(),
    };
  });

  return { tables };
}

export function findTable(schema: SchemaDescription, table: string): TableDescription | undefined {
  return schema.tables.find((candidate) => candidate.name === table);
}
