// The function families `db.query` may not call, and the scan that finds a call. Split from
// `readonly-sql.ts` for the size ceiling. On embedded PGlite — `x dev`'s database — this ban is the
// only layer holding: `statement_timeout` cannot interrupt it, and no SELECT-only role need exist
// there. So what this scan cannot read is refused by the caller, never decoded.

/**
 * Function families a read may not call, matched as a PREFIX of a CALLED function name.
 *
 * The family is the unit, never the name. Refusing `pg_sleep` while admitting `pg_sleep_for` is a
 * distinction only this parser draws, and an exact-name list admits by default: every spelling
 * nobody thought to write down passes. A prefix refuses by default instead, so a member Postgres
 * adds next release is covered on the day it ships.
 *
 * Each family is a ban `readonly-sql.ts` already makes in some other spelling:
 *  - reach outside the database — the original list (`pg_read_*`, `pg_ls_*`, `lo_*`, `dblink`);
 *  - hold a lock, which `FOR UPDATE` is refused for. The call is the worse of the two: a SESSION
 *    advisory lock is not released by the `ROLLBACK` layer 2 always runs, so it outlives the read
 *    on a pooled connection the app's own writers use;
 *  - mutate the server or the session — `set_config` is `SET` spelled as a call, and `SET` is a
 *    write keyword;
 *  - burn the wall clock — layer 2's `statement_timeout` cannot interrupt embedded PGlite
 *    (single-threaded WASM), which is the database `x dev` runs;
 *  - ADVANCE A SEQUENCE (`nextval`, `setval`) — a write that leaves no keyword behind, and one
 *    `ROLLBACK` does not undo: a consumed sequence value is gone, so a read can silently burn the
 *    next id a real insert would have taken. `currval`/`lastval` read the session and stay legal.
 *    `txid_current`/`pg_current_xact_id` are the same ban one level down: they ASSIGN a real
 *    transaction id to a read, and a rollback does not give it back;
 *  - PUBLISH A MESSAGE — `pg_notify` is `NOTIFY` spelled as a call. The keyword scan cannot see
 *    it: it is one token;
 *  - CONTROL THE SERVER (`pg_reload_*`, `pg_rotate_*`, `pg_switch_*`, `pg_promote`,
 *    `pg_wal_replay_*`) — the family `pg_cancel_backend`/`pg_terminate_backend` established;
 *  - CONSUME THE REPLICATION STREAM (`pg_create_*`, `pg_drop_*`, `pg_replication_*`,
 *    `pg_logical_*`) — `pg_logical_slot_get_changes` advances a slot's confirmed position. The
 *    catalog VIEWS beside them (`pg_replication_slots`) are read `from`, never called;
 *  - WRITE A FILE (`pg_file_*`) — the other half of `pg_read_*`;
 *  - WRITE THE CATALOG (`pg_import_*`) — `pg_import_system_collations` inserts `pg_collation` rows;
 *  - RUN A QUERY HANDED TO IT AS TEXT (`query_to_xml*`, `cursor_to_xml*`, `table_to_xml*`,
 *    `schema_to_xml*`, `database_to_xml*`, `ts_stat`, `ts_rewrite`) — the statement is a string
 *    literal, which every pass of the scan blanks by design, so whatever it calls is invisible.
 *
 * The prefix is applied to a CALL — a name followed by `(` — and never to a bare word, so a
 * column called `pg_sleep_for_seconds` stays readable. Quoting does not evade it: the scan reads
 * a form where a quoted identifier keeps its content, because `"pg_advisory_lock"(1)` is the same
 * call as `pg_advisory_lock(1)`.
 */
const FORBIDDEN_FUNCTIONS = [
  'cursor_to_xml',
  'database_to_xml',
  'dblink',
  'lo_',
  'nextval',
  'pg_advisory_',
  'pg_cancel_backend',
  'pg_create_',
  'pg_current_xact_id',
  'pg_drop_',
  'pg_file_',
  'pg_import_',
  'pg_logical_',
  'pg_ls_',
  'pg_notify',
  'pg_promote',
  'pg_read_',
  'pg_reload_',
  'pg_replication_',
  'pg_rotate_',
  'pg_sleep',
  'pg_stat_file',
  'pg_stat_reset',
  // Not reachable from `pg_stat_reset`: the extension spells the same reset with the statistics
  // view's name in the middle, so a prefix of one is not a prefix of the other.
  'pg_stat_statements_reset',
  'pg_switch_',
  'pg_terminate_backend',
  'pg_try_advisory_',
  'pg_wal_replay_',
  'query_to_xml',
  'schema_to_xml',
  'set_config',
  'setval',
  'table_to_xml',
  'ts_rewrite',
  'ts_stat',
  'txid_current',
];

/** The family refusing `called`, or `undefined`. A prefix, so a new member is refused by default. */
export function forbiddenFamily(called: string): string | undefined {
  return FORBIDDEN_FUNCTIONS.find((family) => called.startsWith(family));
}

/**
 * A call: an identifier immediately before `(`. Schema qualification falls out of the scan —
 * `pg_catalog.set_config(` matches on the last segment, which is the function being called.
 */
const CALL_PATTERN = /([a-z_][a-z0-9_$]*)\s*\(/g;

/** Every function `sql` calls, lowercased. Read from the identifier-preserving strip. */
export function calledFunctions(sql: string): readonly string[] {
  const names: string[] = [];
  for (const match of sql.toLowerCase().matchAll(CALL_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}
