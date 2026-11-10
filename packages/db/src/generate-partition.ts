// Single responsibility: `entity({ partitionBy })` as SQL — the parent's `partition by range`
// clause and the ONE plpgsql function that creates the partitions ahead and drops expired ones. The
// migration creating the table and the maintenance job both call it, so both name and bound a
// partition identically, and both read the database's clock unless handed one.

import { renderFixShellArg } from '@ultimat3/core';
import type { EntityDescriptionLike, PartitionDescriptionLike } from './entity-shape';
import { DbError } from './errors';
import { findTable, type SchemaDescription } from './introspect';
import { identifier, literal, raw, type SqlFragment, sql } from './sql';

/** The column kinds a range can be bounded by: `timestamp()` and `date()`. */
export const PARTITION_KINDS = ['timestamptz', 'date'] as const;

/** `_p20261101`: the suffix every partition carries — its lower bound, UTC, `YYYYMMDD`. */
export const PARTITION_SUFFIX_BYTES = 10;

export const PARTITION_FUNCTION = 'ultimate_partitions';

/** A bound, spelled independently of `DateStyle` and `TimeZone`: UTC, ISO. */
const bound = (at: string): string =>
  `case when kind = 'date' then to_char(${at}, 'YYYY-MM-DD') ` +
  `else to_char(${at}, 'YYYY-MM-DD HH24:MI:SS') || '+00' end`;

/** What a retiring partition's comment says, so a detached orphan is known to be this package's. */
export const RETIRING_COMMENT = 'ultimate:partition-retiring';

/**
 * Creates every partition from `since`'s (the current one when `since` is null) through `ahead`
 * past the current one (`if not exists`, so a double fire is a no-op). With `keep_ms`, it also
 * NAMES — never touches — every `<parent>_pYYYYMMDD` whose upper bound is `keep_ms` before
 * `instant`, with its state: `attached`, `pending` (a `detach … concurrently` interrupted) or
 * `detached` (detached by a run that died before its drop, known by `RETIRING_COMMENT`). The caller
 * retires them outside any transaction (`generate-partition-run.ts`): `detach … concurrently`
 * cannot run inside a function. Refuses a parent that is not partitioned with this package's code.
 * Answers `{ created, expired: [{ name, state }] }`.
 */
export const PARTITION_FUNCTION_SQL =
  `create or replace function ${identifier(PARTITION_FUNCTION).text}(parent text, kind text, ` +
  'unit text, ahead integer, keep_ms bigint, instant timestamptz default now(), ' +
  'since timestamptz default null) returns jsonb ' +
  'language plpgsql as $partitions$ declare ' +
  "step interval := ('1 ' || unit)::interval; " +
  "head timestamp := date_trunc(unit, instant at time zone 'UTC'); " +
  'low timestamp; part text; child record; ' +
  "created text[] := '{}'; expired jsonb := '[]'; " +
  'begin ' +
  'if (select c.relkind from pg_class c where c.oid = to_regclass(quote_ident(parent))) ' +
  "is distinct from 'p' then raise exception 'X_MIGRATION_PARTITION_CHANGE: table % is not " +
  "partitioned, and its entity declares partitionBy', parent using errcode = '42809', " +
  "hint = 'Postgres cannot partition a table in place: declare a new entity with partitionBy, " +
  "run partitions() with from: <its oldest row>, then backfill() it'; end if; " +
  "low := least(head, coalesce(date_trunc(unit, since at time zone 'UTC'), head)); " +
  'while low <= head + step * ahead loop ' +
  "part := parent || '_p' || to_char(low, 'YYYYMMDD'); " +
  'if to_regclass(quote_ident(part)) is null then ' +
  "execute format('create table if not exists %I partition of %I for values from (%L) to (%L)', " +
  `part, parent, ${bound('low')}, ${bound('low + step')}); ` +
  'created := created || part; end if; low := low + step; end loop; ' +
  'if keep_ms is not null then ' +
  'for child in select c.relname::text as name, case when h.inhrelid is null then ' +
  "'detached' when h.inhdetachpending then 'pending' else 'attached' end as state " +
  'from pg_class c left join pg_inherits h on h.inhrelid = c.oid ' +
  'and h.inhparent = to_regclass(quote_ident(parent)) ' +
  "where c.relkind = 'r' and c.relnamespace = (select p.relnamespace from pg_class p " +
  'where p.oid = to_regclass(quote_ident(parent))) ' +
  `and length(c.relname) = length(parent) + ${PARTITION_SUFFIX_BYTES} ` +
  "and left(c.relname, length(parent) + 2) = parent || '_p' " +
  "and right(c.relname, 8) ~ '^[0-9]{8}$' " +
  'and (h.inhrelid is not null or (not c.relispartition and ' +
  `obj_description(c.oid, 'pg_class') = '${RETIRING_COMMENT}')) order by c.relname loop ` +
  "if to_date(right(child.name, 8), 'YYYYMMDD')::timestamp + step <= " +
  "(instant at time zone 'UTC') - make_interval(secs => keep_ms / 1000.0) then " +
  "expired := expired || jsonb_build_object('name', child.name, 'state', child.state); " +
  'end if; end loop; end if; ' +
  "return jsonb_build_object('created', to_jsonb(created), 'expired', expired); " +
  'end; $partitions$;';

/**
 * The function's first signature, before `since` existed: `create or replace` with another argument
 * list makes an OVERLOAD, and a call naming five arguments then matches both (`42725`).
 */
export const PARTITION_FUNCTION_RETIRED_SQL =
  `drop function if exists ${identifier(PARTITION_FUNCTION).text}` +
  '(text, text, text, integer, bigint, timestamptz);';

/** ` partition by range ("at")` — appended to the parent's `create table (…)`. */
export const partitionByClause = (partition: PartitionDescriptionLike): string =>
  ` partition by range (${identifier(partition.column).text})`;

/** The partition column's kind, read off the description's own column. */
const kindOf = (entity: EntityDescriptionLike, partition: PartitionDescriptionLike): string =>
  entity.columns.find((column) => column.column === partition.column)?.kind ?? 'timestamptz';

/**
 * The migration's call: partitions from the APPLY time onward, never a retention sweep — a
 * migration replayed a year later (a fresh clone, a test database) still has this month's.
 */
export function partitionMigrationCall(entity: EntityDescriptionLike): string | null {
  const partition = entity.partition;
  if (partition === undefined) return null;
  const args = [
    literal(entity.table).text,
    literal(kindOf(entity, partition)).text,
    literal(partition.interval).text,
    String(Math.trunc(partition.ahead)),
    'null',
  ].join(', ');
  return `select ${identifier(PARTITION_FUNCTION).text}(${args});`;
}

/** `from`: also create every partition back to this instant's — before a `backfill()` copies old rows. */
export interface PartitionMaintenanceOptions {
  readonly from?: Date | undefined;
}

/**
 * The maintenance statement: create ahead, and name what `retain` expired (retired by
 * `maintainPartitions`, never here), judged at `instant` — the framework clock's now, never the server's, so a test can move it.
 * With `from`, it also creates every partition back to `from`'s and sweeps NOTHING: a backfill's
 * preparation must not drop the partitions it just made for rows older than the window.
 * Answers one row, `{ result: { created, expired } }`. `null` on a plain table.
 */
export function partitionMaintenance(
  entity: EntityDescriptionLike,
  instant: Date,
  options: PartitionMaintenanceOptions = {},
): SqlFragment | null {
  const partition = entity.partition;
  if (partition === undefined) return null;
  const from = options.from === undefined ? null : options.from.toISOString();
  const keep =
    partition.retain === undefined || from !== null ? null : Math.trunc(partition.retain.afterMs);
  return sql`select ${raw(identifier(PARTITION_FUNCTION).text)}(${entity.table}, ${kindOf(entity, partition)}, ${partition.interval}, ${Math.trunc(partition.ahead)}::integer, ${keep}::bigint, ${instant.toISOString()}::timestamptz, ${from}::timestamptz) as result`;
}

/**
 * A NEW partitioned table gets the function and its first partitions; an existing one that newly
 * declares `partitionBy` gets them too — if the hand-edit recipe already partitioned it, that is
 * adoption, and if it is a plain table the function refuses it at migrate time with
 * `X_MIGRATION_PARTITION_CHANGE`. A table the snapshot records partitioned and the entity no
 * longer declares is refused here: no statement turns it back.
 */
export function partitionPlan(
  plan: { up: string[] },
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
): void {
  let installed = false;
  for (const entity of entities) {
    const recorded = findTable(current, entity.table);
    const call = partitionMigrationCall(entity);
    if (call === null) {
      if (recorded?.partitioned === true) throw partitionDropped(entity.name, entity.table);
      continue;
    }
    const was = recorded?.partitionInterval;
    const now = entity.partition?.interval;
    if (was !== undefined && now !== undefined && was !== now) {
      throw partitionRewidened(entity.name, entity.table, was, now);
    }
    if (recorded?.partitioned === true) continue;
    if (!installed) plan.up.push(PARTITION_FUNCTION_RETIRED_SQL, PARTITION_FUNCTION_SQL);
    installed = true;
    plan.up.push(call);
  }
}

/** An existing partitioned table losing `partitionBy`: no in-place statement does it. */
export const partitionDropped = (entity: string, table: string): DbError =>
  new DbError({
    code: 'X_MIGRATION_PARTITION_CHANGE',
    cause: `entity "${entity}" no longer declares partitionBy, and its table "${table}" was created partitioned: Postgres cannot turn it back into a plain table in place`,
    fix: `x db gen "unpartition"   # after putting partitionBy back on entity('${renderFixShellArg(entity, '<entity>')}'), or moving its rows to a new plain entity with backfill()`,
    meta: { entity, table },
  });

/** A partitioned table's interval changing: partitions of the new width would overlap the old. */
export const partitionRewidened = (
  entity: string,
  table: string,
  was: string,
  now: string,
): DbError =>
  new DbError({
    code: 'X_MIGRATION_PARTITION_CHANGE',
    cause: `entity "${entity}" changes its partition interval from ${was} to ${now}, and "${table}" already holds ${was} partitions: Postgres cannot repartition in place, and new ones would overlap`,
    fix: `x db gen "repartition"   # after putting interval: '${was}' back on entity('${renderFixShellArg(entity, '<entity>')}'), or declaring a new entity with interval: '${now}', running partitions() with { from: <oldest row's instant> }, then backfill() into it`,
    meta: { entity, table },
  });
