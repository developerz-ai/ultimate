// Single responsibility: the seven catalog reads behind `dbDiagnostics`, one constant statement
// each. Catalog and statistics views only — no statement here reads a user table, so no row value
// can be in an answer; the one free text (`query`) is redacted by the caller before it leaves.

/** Every database name filter is `current_database()`: a shared server's other tenants are not ours. */
const OUR_DATABASE = 'datname = current_database()';

/** Waiting sessions and the pid each one waits on, longest wait first. */
export const BLOCKERS_SQL = `select w.pid as pid, b.pid as blocked_by, w.wait_event_type as wait_event_type,
  w.wait_event as wait_event, round(extract(epoch from now() - w.query_start))::int as waiting_seconds,
  w.query as query, b.state as blocker_state,
  round(extract(epoch from now() - b.xact_start))::int as blocker_transaction_seconds,
  b.query as blocker_query
from pg_stat_activity w
cross join lateral unnest(pg_blocking_pids(w.pid)) as blocker(pid)
join pg_stat_activity b on b.pid = blocker.pid
where w.${OUR_DATABASE}
order by waiting_seconds desc nulls last, w.pid`;

/**
 * Every client session that is not idle, oldest transaction first. A session another role owns
 * reads `<insufficient privilege>` without `pg_read_all_stats`: reported as `query_visible`.
 */
export const ACTIVITY_SQL = `select pid, usename as role, application_name, state,
  wait_event_type, wait_event,
  round(extract(epoch from now() - xact_start))::int as transaction_seconds,
  round(extract(epoch from now() - query_start))::int as query_seconds,
  query is distinct from '<insufficient privilege>' as query_visible, query
from pg_stat_activity
where ${OUR_DATABASE} and pid <> pg_backend_pid() and backend_type = 'client backend'
  and coalesce(state, '') <> 'idle'
order by xact_start nulls last, pid`;

/**
 * `pg_stat_statements` is an extension: on a server without it this is `42P01` and the section is
 * reported unavailable. Its text is what the server normalised; the caller redacts it anyway, since
 * a utility statement is stored as sent.
 */
export const SLOW_QUERIES_SQL = `select queryid::text as query_id, calls,
  round(total_exec_time::numeric, 1)::float8 as total_ms,
  round(mean_exec_time::numeric, 2)::float8 as mean_ms, rows, query
from pg_stat_statements
where dbid = (select oid from pg_database where ${OUR_DATABASE})
order by total_exec_time desc`;

/**
 * Never scanned since the counters were reset. Unique and primary indexes are excluded: they
 * enforce, and a scan count does not measure that. The counters' age and the server's recovery
 * state ride on each row, because a count since yesterday, or on a replica, is not "unused".
 */
export const UNUSED_INDEXES_SQL = `select s.schemaname as schema, s.relname as table_name,
  s.indexrelname as index_name, pg_relation_size(s.indexrelid) as size_bytes,
  (select round(extract(epoch from now() - d.stats_reset))::int
     from pg_stat_database d where d.${OUR_DATABASE}) as stats_age_seconds,
  pg_is_in_recovery() as replica
from pg_stat_user_indexes s
join pg_index i on i.indexrelid = s.indexrelid
where s.idx_scan = 0 and not i.indisunique and not i.indisprimary
order by pg_relation_size(s.indexrelid) desc, s.indexrelname`;

const USER_SCHEMA = (column: string): string =>
  `${column} not in ('pg_catalog', 'information_schema') and ${column} not like 'pg\\_toast%'`;

/** An index a failed `create index concurrently` left behind: written to, never read from. */
export const INVALID_INDEXES_SQL = `select n.nspname as schema, t.relname as table_name,
  c.relname as index_name
from pg_index i
join pg_class c on c.oid = i.indexrelid
join pg_class t on t.oid = i.indrelid
join pg_namespace n on n.oid = c.relnamespace
where not i.indisvalid and ${USER_SCHEMA('n.nspname')}
order by n.nspname, t.relname, c.relname`;

/** Added `not valid` and never validated: new rows are checked, old ones are not. Names only. */
export const NOT_VALID_CONSTRAINTS_SQL = `select n.nspname as schema, t.relname as table_name,
  c.conname as constraint_name,
  case c.contype when 'c' then 'check' when 'f' then 'foreign-key' else c.contype::text end as kind
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where not c.convalidated and ${USER_SCHEMA('n.nspname')}
order by n.nspname, t.relname, c.conname`;

/** Counts and ages from the statistics collector; no estimate of bloat, which would be a guess. */
export const DEAD_TUPLES_SQL = `select schemaname as schema, relname as table_name,
  n_live_tup as live, n_dead_tup as dead,
  round(extract(epoch from now() - last_autovacuum))::int as autovacuum_age_seconds,
  round(extract(epoch from now() - greatest(last_vacuum, last_autovacuum)))::int as vacuum_age_seconds,
  round(extract(epoch from now() - greatest(last_analyze, last_autoanalyze)))::int as analyze_age_seconds
from pg_stat_user_tables
where n_dead_tup > 0
order by n_dead_tup desc, relname`;
