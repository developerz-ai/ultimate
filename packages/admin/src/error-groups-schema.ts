// The DDL of the error-groups table, and nothing else: a LEAF module, so the boot's
// `FRAMEWORK_SCHEMA` (`@ultimat3/cli`) can apply it in every role without pulling one screen into
// a worker's module graph — `audit-schema.ts`'s rule, for the same reason.

/** The table. One name, read by this DDL and by `error-groups-pg.ts`'s statements. */
export const ERROR_GROUPS_TABLE = 'x_error_groups';

/**
 * Applied by the boot, never by an app migration — the rule every framework table follows.
 *
 * **One row per fingerprint** (`errorFingerprint`, core): the primary key IS the group, so the
 * upsert's `xmax = 0` answers "this insert made it" for exactly one of N racing replicas.
 *
 * **`sample` is what the sink already redacted** — credentials by key, the stack cut — and never
 * the thrown value. A replayable bundle is `x_failures`', not this table's.
 *
 * **One index**, `(last_seen desc, fingerprint)`: the list screen's order and the purge's range.
 * Retention is the app's: `errorGroupsPurgeTarget(store, { olderThanMs })` has no default.
 */
export const SQL_ERROR_GROUPS_TABLE = `
create table if not exists x_error_groups (
  fingerprint text        primary key,
  code        text        not null,
  source      text        not null,
  operation   text,
  message     text        not null,
  status      text        not null default 'open',
  first_seen  timestamptz not null,
  last_seen   timestamptz not null,
  count       bigint      not null,
  sample      jsonb       not null
);

create index if not exists x_error_groups_seen_idx
  on x_error_groups (last_seen desc, fingerprint);
`;
