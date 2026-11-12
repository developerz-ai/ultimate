// Single responsibility: the two triggers `entity({ history: true })` compiles to. One records a
// before and an after image of every row change into `<table>_history`; the other refuses every
// rewrite of that history, and every delete but a purge's. Triggers and not the repository, because
// only a trigger sees `updateWhere`, a cascade and raw SQL.

import type { HistoryDescriptionLike } from './entity-shape';
import type { TriggerRecord } from './introspect';
import { identifier, literal } from './sql';

/** On the PARENT table. One name everywhere: a trigger name is unique per table, never per schema. */
export const HISTORY_TRIGGER = 'ultimate_history';
/** On the HISTORY table. */
export const HISTORY_GUARD_TRIGGER = 'ultimate_history_guard';
export const HISTORY_FUNCTION = 'ultimate_record_history';
export const HISTORY_GUARD_FUNCTION = 'ultimate_guard_history';

/** The transaction-local settings the two functions read. `setLocal` is their one writer. */
export const ACTOR_SETTING = 'x.actor';
export const REQUEST_SETTING = 'x.request';
export const PURGE_SETTING = 'x.purge';

/** A JSON number's own digits, as text: `->>` spells a jsonb numeric exactly, scale included. */
const DIGITS = { type: 'number', text: '{image} ->> k' };
/** The instant `to_jsonb` spelled with the session's offset, re-spelled in UTC as `toISOString`. */
const INSTANT = {
  type: 'string',
  text: `to_char(({image} ->> k)::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
};

/** One image's key `k` replaced by its text, when it holds the JSON type `to_jsonb` gave it. */
const exact = (image: string, how: { readonly type: string; readonly text: string }): string =>
  `if jsonb_typeof(${image} -> k) = '${how.type}' then ${image} := jsonb_set(${image}, array[k], ` +
  `coalesce(to_jsonb(${how.text.replaceAll('{image}', image)}), ${image} -> k)); end if;`;

/**
 * One function for every history table: the trigger's arguments name the table, the key, the tenant
 * column, the columns whose change alone records nothing (the counters the database keeps), and the
 * columns `to_jsonb` spells otherwise than the row: an `int8`/`numeric` stored as its digits (a JSON
 * number is a float to every reader past 2^53 and drops a scale's zeros), a `timestamptz` as UTC ISO
 * to the millisecond (`to_jsonb` writes the SESSION zone's offset) — what the memory driver keeps —
 * and the sealed columns, removed from both images before anything else reads them: ciphertext, and
 * a lookup column's is deterministic, so history would compare rows the app cannot. Their change
 * alone records nothing, exactly as an ignored column's.
 * An argument a trigger installed before it existed reads NULL, and NULL is the empty list.
 *
 * `jsonb_populate_record` builds the history row, so every value lands in its column's own type —
 * a uuid tenant from a jsonb text, with no cast spliced per table. A statement that changes nothing
 * records nothing; the actor and request are what the WRITE'S transaction set, so a statement with
 * no transaction around it records `null`, never a guess.
 */
export const HISTORY_FUNCTION_SQL =
  `create or replace function ${identifier(HISTORY_FUNCTION).text}() returns trigger ` +
  'language plpgsql as $history$ declare ' +
  "source jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end; " +
  "prior jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end; " +
  'ignored text[] := tg_argv[3]::text[]; ' +
  "digits text[] := coalesce(tg_argv[4], '{}')::text[]; " +
  "instants text[] := coalesce(tg_argv[5], '{}')::text[]; " +
  "sealed text[] := coalesce(tg_argv[6], '{}')::text[]; " +
  'k text; ' +
  'begin source := source - sealed; prior := prior - sealed; ' +
  "if tg_op = 'UPDATE' and (prior - ignored) = (source - ignored) then return null; end if; " +
  'foreach k in array digits loop ' +
  `${exact('source', DIGITS)} ${exact('prior', DIGITS)} end loop; ` +
  'foreach k in array instants loop ' +
  `${exact('source', INSTANT)} ${exact('prior', INSTANT)} end loop; ` +
  "execute format('insert into %I select * from jsonb_populate_record(null::%I, $1)', " +
  'tg_argv[0], tg_argv[0]) using jsonb_build_object(' +
  "'id', gen_random_uuid(), 'row_id', source ->> tg_argv[1], 'op', lower(tg_op), 'at', now(), " +
  `'actor_id', nullif(current_setting('${ACTOR_SETTING}', true), ''), ` +
  `'request_id', nullif(current_setting('${REQUEST_SETTING}', true), ''), ` +
  "'before', prior, 'after', case when tg_op = 'DELETE' then null else source end) || " +
  "case when tg_argv[2] = '' then '{}'::jsonb " +
  'else jsonb_build_object(tg_argv[2], source -> tg_argv[2]) end; ' +
  'return null; end; $history$;';

/**
 * Update refused always; delete refused unless `x.purge` names THIS table — `retainTarget` and a
 * subject erase set it through `setLocal`. As `x.cross` is, this catches forgetting, not hostile SQL
 * in the app's own process. The code leads the message and the SQLSTATE is `23001`, exactly as the
 * append-only trigger's: a history table is append-only to everything but its sweep.
 */
export const HISTORY_GUARD_FUNCTION_SQL =
  `create or replace function ${identifier(HISTORY_GUARD_FUNCTION).text}() returns trigger ` +
  "language plpgsql as $history_guard$ begin if tg_op = 'DELETE' and " +
  `current_setting('${PURGE_SETTING}', true) = tg_table_name then return old; end if; ` +
  "raise exception 'X_ENTITY_APPEND_ONLY: % on %.% is refused, the table is history', " +
  "tg_op, tg_table_schema, tg_table_name using errcode = '23001', hint = 'history is written " +
  "by its trigger and removed only by purge({ entities: ''declared'' })'; end; $history_guard$;";

/** Function, drop-if-exists, create: idempotent over a missing and a DISABLED trigger alike. */
export const triggerInstall = (
  name: string,
  fn: { readonly name: string; readonly sql: string },
  timing: string,
  table: string,
  args: string,
): TriggerRecord => ({
  name,
  install: [
    fn.sql,
    `drop trigger if exists ${identifier(name).text} on ${identifier(table).text};`,
    `create trigger ${identifier(name).text} ${timing} on ${identifier(table).text} for each row ` +
      `execute function ${identifier(fn.name).text}(${args});`,
  ],
});

/** A text[] literal of physical names — each one already a validated identifier. */
const nameArray = (names: readonly string[]): string =>
  literal(`{${names.map((name) => identifier(name).text).join(',')}}`).text;

/** The parent's recording trigger and the history table's guard, keyed by the table each sits on. */
export function historyTriggers(
  parent: string,
  history: HistoryDescriptionLike,
): readonly (readonly [string, TriggerRecord])[] {
  const args = [
    literal(history.table).text,
    literal(history.key).text,
    literal(history.tenant ?? '').text,
    nameArray(history.ignore),
    nameArray(history.text ?? []),
    nameArray(history.instants ?? []),
    nameArray(history.sealed ?? []),
  ].join(', ');
  return [
    [
      parent,
      triggerInstall(
        HISTORY_TRIGGER,
        { name: HISTORY_FUNCTION, sql: HISTORY_FUNCTION_SQL },
        'after insert or update or delete',
        parent,
        args,
      ),
    ],
    [
      history.table,
      triggerInstall(
        HISTORY_GUARD_TRIGGER,
        { name: HISTORY_GUARD_FUNCTION, sql: HISTORY_GUARD_FUNCTION_SQL },
        'before update or delete',
        history.table,
        '',
      ),
    ],
  ];
}
