// Single responsibility: compile every pgvector statement. It lives apart from the store for
// the same reason `@ultimat3/entity` splits `pg-sql.ts` from `pg-driver.ts` — the SQL an agent
// has to read when a search is slow or wrong should be one file it can open, and every scalar
// here goes through `sql` so a metadata key or a tenant id can never become syntax.

import { identifier, join, literal, type SqlFragment, sql } from '@ultimat3/db';
import type { MetadataFilter } from './vector';
import type { VectorScope } from './vector-scope';

export interface PgVectorTable {
  readonly table: string;
  readonly dimension: number;
  /** The `regconfig` the FTS column and every query share. Both sides must agree or `@@` lies. */
  readonly language: string;
}

/** Nothing matches. `in ()` is a syntax error, so an empty allow-list needs a constant. */
const NEVER = sql`1 = 0`;
const ALWAYS = sql`true`;

/** pgvector's text input form. Float32 widens to double exactly, so no precision is invented. */
export function vectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector).join(',')}]`;
}

/**
 * The scope and the per-call filter as one `where` body. Every read, write and delete is built
 * on top of this, which is what makes "tenant filters are applied in SQL" structural rather
 * than a convention someone has to remember at each call site.
 */
export function conditionsSql(scope: VectorScope, filter?: MetadataFilter): SqlFragment {
  const parts: SqlFragment[] = [];
  if (scope.tenant !== undefined) parts.push(sql`"tenant" = ${scope.tenant}`);
  for (const [key, values] of Object.entries(scope.allow ?? {})) {
    parts.push(
      values.length === 0
        ? NEVER
        : sql`"metadata" ->> ${key} in (${join(values.map((value) => sql`${value}`))})`,
    );
  }
  for (const [key, value] of Object.entries(filter ?? {})) {
    parts.push(sql`"metadata" ->> ${key} = ${value}`);
  }
  return parts.length === 0 ? ALWAYS : join(parts, ' and ');
}

/**
 * The store's whole schema as one string, for an app to split across migration files. **No
 * command emits it** — `x db gen` diffs `describeEntities()` and a vector store is not an
 * `entity()`, so no CLI file references this at all.
 *
 * The primary key is `(tenant, id)`, not `id`: it makes a cross-tenant
 * overwrite impossible at the storage layer instead of relying on every upsert remembering to
 * check. An unscoped store writes the empty tenant, which is a tenant like any other.
 */
export function ddlSql(target: PgVectorTable): string {
  const table = identifier(target.table).text;
  const language = literal(target.language).text;
  return [
    `create extension if not exists vector;`,
    `create table if not exists ${table} (`,
    `  tenant text not null default '',`,
    `  id text not null,`,
    `  embedding vector(${target.dimension}) not null,`,
    `  content text not null,`,
    `  metadata jsonb not null default '{}',`,
    `  tsv tsvector generated always as (to_tsvector(${language}, content)) stored,`,
    `  primary key (tenant, id)`,
    `);`,
    `create index if not exists ${indexName(target.table, 'embedding')}`,
    `  on ${table} using hnsw (embedding vector_cosine_ops);`,
    `create index if not exists ${indexName(target.table, 'tsv')} on ${table} using gin (tsv);`,
    `create index if not exists ${indexName(target.table, 'metadata')}`,
    `  on ${table} using gin (metadata jsonb_path_ops);`,
  ].join('\n');
}

const indexName = (table: string, column: string): string =>
  identifier(`${table}_${column}_idx`).text;

export interface PgVectorRowInput {
  readonly id: string;
  readonly vector: Float32Array;
  readonly text: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export function upsertSql(
  target: PgVectorTable,
  tenant: string,
  records: readonly PgVectorRowInput[],
): SqlFragment {
  // `::text::jsonb`, not `::jsonb`: a bound string cast straight to jsonb is JSON-encoded a
  // SECOND time and lands as a jsonb *string*, which reads back fine and makes every
  // `metadata ->> key` filter match nothing. Found live, invisible to a unit test of the reads.
  const rows = records.map(
    (record) =>
      sql`(${tenant}, ${record.id}, ${vectorLiteral(record.vector)}::vector, ${record.text}, ${JSON.stringify(record.metadata)}::text::jsonb)`,
  );
  return sql`insert into ${identifier(target.table)} ("tenant", "id", "embedding", "content", "metadata")
values ${join(rows)}
on conflict ("tenant", "id") do update set
  "embedding" = excluded."embedding",
  "content" = excluded."content",
  "metadata" = excluded."metadata"`;
}

export interface PgSearchArgs {
  readonly scope: VectorScope;
  readonly filter?: MetadataFilter | undefined;
  readonly k: number;
}

/**
 * `<=>` is cosine DISTANCE, so the score is `1 - distance` — the same scale the memory store
 * returns. The ordering stays on the raw distance, ascending, inside a subquery: HNSW answers
 * `order by embedding <=> $1` and nothing else, and `order by 1 - (...) desc` is a seq scan.
 */
export function searchSql(
  target: PgVectorTable,
  vector: Float32Array,
  args: PgSearchArgs,
): SqlFragment {
  return sql`select "id", "content", "metadata", 1 - distance as score
from (
  select "id", "content", "metadata", "embedding" <=> ${vectorLiteral(vector)}::vector as distance
  from ${identifier(target.table)}
  where ${conditionsSql(args.scope, args.filter)}
  order by distance
  limit ${args.k}
) top
order by distance`;
}

export function textSql(target: PgVectorTable, query: string, args: PgSearchArgs): SqlFragment {
  return sql`select "id", "content", "metadata", ts_rank_cd("tsv", q) as score
from ${identifier(target.table)}, websearch_to_tsquery(${target.language}::regconfig, ${query}) q
where "tsv" @@ q and ${conditionsSql(args.scope, args.filter)}
order by score desc
limit ${args.k}`;
}

export interface PgHybridArgs extends PgSearchArgs {
  readonly candidates: number;
  readonly rrfK: number;
}

/**
 * Reciprocal-rank fusion, done in SQL. Two candidate sets are ranked independently and fused by
 * `1 / (rrfK + rank)` — identical to `fuse()` in `vector.ts`, so dev and production order hits
 * the same way. Both CTEs carry the SAME scope conditions: fusing an unfiltered lexical ranking
 * into a filtered dense one would leak the other tenant's rows through the back door.
 */
export function hybridSql(
  target: PgVectorTable,
  query: string,
  vector: Float32Array,
  args: PgHybridArgs,
): SqlFragment {
  const table = identifier(target.table);
  const where = conditionsSql(args.scope, args.filter);
  return sql`with dense as (
  select "tenant", "id", row_number() over (order by distance) as rank
  from (
    select "tenant", "id", "embedding" <=> ${vectorLiteral(vector)}::vector as distance
    from ${table}
    where ${where}
    order by distance
    limit ${args.candidates}
  ) top
), lexical as (
  select "tenant", "id", row_number() over (order by relevance desc) as rank
  from (
    select "tenant", "id", ts_rank_cd("tsv", q) as relevance
    from ${table}, websearch_to_tsquery(${target.language}::regconfig, ${query}) q
    where "tsv" @@ q and ${where}
    order by relevance desc
    limit ${args.candidates}
  ) top
), fused as (
  select "tenant", "id", sum(1.0 / (${args.rrfK} + rank))::double precision as score
  from (
    select "tenant", "id", rank from dense
    union all
    select "tenant", "id", rank from lexical
  ) ranked
  group by "tenant", "id"
)
select d."id", d."content", d."metadata", f.score
from fused f join ${table} d on d."tenant" = f."tenant" and d."id" = f."id"
order by f.score desc, d."id" asc
limit ${args.k}`;
}

export function deleteSql(
  target: PgVectorTable,
  scope: VectorScope,
  ids: readonly string[],
): SqlFragment {
  return sql`delete from ${identifier(target.table)}
where "id" in (${join(ids.map((id) => sql`${id}`))}) and ${conditionsSql(scope)}`;
}
