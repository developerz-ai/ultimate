// Single responsibility: the two constant catalog reads behind the Postgres stats gauges. Statistics
// views and settings only — no statement here reads a user table, and none takes a lock.

/**
 * One row. `connections` counts every client backend on the SERVER, because `max_connections` is
 * the server's: another database's sessions spend the same budget. The longest transaction is this
 * database's own; without `pg_read_all_stats` another role's `xact_start` reads null, so it is the
 * longest this role can see. The autovacuum backlog is the worst table's dead tuples over the count
 * that triggers its autovacuum (global settings; a per-table override is not read): above 1 the
 * table is due, and staying above it means autovacuum is not keeping up. A trigger of 0 (threshold
 * 0 over an empty table) is skipped by `nullif`: float8 `0 / 0` raises and took the round with it.
 */
export const PG_SERVER_STATS_SQL = `select
  (select count(*) from pg_stat_activity where backend_type = 'client backend')::int as connections,
  current_setting('max_connections')::int as max_connections,
  coalesce((select extract(epoch from max(now() - xact_start)) from pg_stat_activity
    where datname = current_database() and backend_type = 'client backend'
      and xact_start is not null and pid <> pg_backend_pid()), 0)::float8 as longest_transaction_seconds,
  coalesce((select max(s.n_dead_tup / nullif(current_setting('autovacuum_vacuum_threshold')::float8
      + current_setting('autovacuum_vacuum_scale_factor')::float8 * greatest(c.reltuples, 0), 0))
    from pg_stat_user_tables s join pg_class c on c.oid = s.relid), 0)::float8 as autovacuum_backlog_ratio`;

/**
 * The WAL each of this database's logical slots holds back on the primary: what an inactive or
 * lagging replicator costs in disk. Bounded by `max_replication_slots`. A standby answers no rows —
 * `pg_current_wal_lsn()` is refused during recovery, and a standby retains nothing for a slot.
 */
export const PG_SLOT_STATS_SQL = `select slot_name as slot,
  pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::float8 as retained_bytes
from pg_replication_slots
where database = current_database() and restart_lsn is not null and not pg_is_in_recovery()`;
