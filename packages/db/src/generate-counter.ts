// Single responsibility: the trigger `references(…, { countedIn })` compiles to, and the
// recount that makes a counter true again. The trigger sits on the CHILD and moves the parent's
// integer in the same transaction, so `deleteWhere`, `upsertAll` and raw SQL keep it as an insert does.

import type { CounterDescriptionLike } from './entity-shape';
import { triggerInstall } from './generate-history';
import type { TriggerRecord } from './introspect';
import { identifier, raw, type SqlFragment, sql } from './sql';

/**
 * `ultimate_count_<crc32 of parent.column>`: per counter, because each body names its own tables,
 * and short, because a name past 63 bytes is truncated in silence and drift would compare the
 * untruncated one forever. CRC32 is Bun's, stable across processes and platforms.
 */
export function counterTriggerName(parent: string, counter: CounterDescriptionLike): string {
  const hash = Bun.hash.crc32(`${parent}.${counter.column}`).toString(16).padStart(8, '0');
  return `ultimate_count_${hash}`;
}

/**
 * Whether a row image (`old`/`new`) is counted: it names a parent, is not soft-deleted, and — with a
 * `where` — the predicate holds over it. The predicate names the child as `c`, so the image is
 * given that alias in a one-row subquery: one compiled text serves the trigger and the recount.
 */
const counted = (image: 'old' | 'new', counter: CounterDescriptionLike): string =>
  `${image}.${identifier(counter.references).text} is not null` +
  (counter.softDelete === null
    ? ''
    : ` and ${image}.${identifier(counter.softDelete).text} is null`) +
  (counter.where === undefined
    ? ''
    : ` and exists (select from (select ${image}.*) c where ${counter.where.sql})`);

const bump = (parent: string, counter: CounterDescriptionLike, image: string, sign: string) =>
  `update ${identifier(parent).text} set ${identifier(counter.column).text} = ` +
  `${identifier(counter.column).text} ${sign} 1 where ${identifier(counter.key).text} = ` +
  `${image}.${identifier(counter.references).text};`;

/**
 * Old image out, new image in: an insert adds one, a delete takes one, a re-parent or a soft delete
 * moves it. Lock order is the PARENT row, so a hot parent serializes its writers — `countBy` plus a
 * cache is the alternative where that matters. `after … for each row`, so a refused write moves
 * nothing, and `update of` the columns that can change the answer — key, stamp, the predicate's —
 * so no other update pays.
 */
export function counterTrigger(parent: string, counter: CounterDescriptionLike): TriggerRecord {
  const name = counterTriggerName(parent, counter);
  const fn =
    `create or replace function ${identifier(name).text}() returns trigger language plpgsql as ` +
    `$counter$ begin if tg_op <> 'INSERT' and ${counted('old', counter)} then ` +
    `${bump(parent, counter, 'old', '-')} end if; if tg_op <> 'DELETE' and ` +
    `${counted('new', counter)} then ${bump(parent, counter, 'new', '+')} end if; ` +
    'return null; end; $counter$;';
  const watched = [
    ...new Set([
      counter.references,
      ...(counter.softDelete === null ? [] : [counter.softDelete]),
      ...(counter.where?.columns ?? []),
    ]),
  ]
    .map((column) => identifier(column).text)
    .join(', ');
  return triggerInstall(
    name,
    { name, sql: fn },
    `after insert or delete or update of ${watched}`,
    counter.table,
    '',
  );
}

/** The true count of one parent row, as a correlated subquery over `parent` aliased `p`. */
const truth = (counter: CounterDescriptionLike): string =>
  `(select count(*)::integer from ${identifier(counter.table).text} c where ` +
  `c.${identifier(counter.references).text} = p.${identifier(counter.key).text}` +
  (counter.softDelete === null ? '' : ` and c.${identifier(counter.softDelete).text} is null`) +
  (counter.where === undefined ? '' : ` and (${counter.where.sql})`) +
  ')';

/**
 * Sets every drifted counter to the truth. A migration adding a counter runs it once, so a table
 * that already holds rows starts true. Migration-only: it locks nothing first, so it is not safe
 * beside live writers — `x db recount --write` repairs by key range instead (`recountLockSql`,
 * then `recountBatchSql`), one transaction per window.
 */
export function recountSql(parent: string, counter: CounterDescriptionLike): string {
  return (
    `update ${identifier(parent).text} p set ${identifier(counter.column).text} = ${truth(counter)} ` +
    `where p.${identifier(counter.column).text} is distinct from ${truth(counter)};`
  );
}

/** The drifted rows, for `x db recount`'s report: key, stored and true count. */
export function recountDriftSql(parent: string, counter: CounterDescriptionLike): string {
  return (
    `select p.${identifier(counter.key).text}::text as "key", ` +
    `p.${identifier(counter.column).text} as "stored", ${truth(counter)} as "actual" ` +
    `from ${identifier(parent).text} p ` +
    `where p.${identifier(counter.column).text} is distinct from ${truth(counter)} ` +
    `order by p.${identifier(counter.key).text}`
  );
}

/** `p.key > $after and p.key <= $last`, the half-open window one batch covers; no lower bound first. */
const windowOf = (
  counter: CounterDescriptionLike,
  after: string | null,
  last: string,
): SqlFragment => {
  const key = raw(`p.${identifier(counter.key).text}`);
  return after === null ? sql`${key} <= ${last}` : sql`${key} > ${after} and ${key} <= ${last}`;
};

/**
 * The last key of the next window: up to `size` parent keys past `after`, in key order. `null` when
 * none is left. Keys travel as text so any single-column key type bounds the next window.
 */
export function recountWindowSql(
  parent: string,
  counter: CounterDescriptionLike,
  after: string | null,
  size: number,
): SqlFragment {
  const key = raw(`p.${identifier(counter.key).text}`);
  const table = identifier(parent);
  const from = raw(`select ${key.text}::text as "key" from ${table.text} p`);
  const keys =
    after === null
      ? sql`${from} order by ${key} limit ${size}`
      : sql`${from} where ${key} > ${after} order by ${key} limit ${size}`;
  return sql`select max(w."key") as "last" from (${keys}) w`;
}

/**
 * Locks one window's parent rows, in key order, as a counter's trigger locks a parent (`for no key
 * update`, `pg-lock.ts`'s mode). Sent FIRST in the window's transaction: a writer whose trigger
 * already holds a row commits before this returns, and the drift read and repair that follow, each
 * its own statement under READ COMMITTED, take a snapshot that counts it; a writer arriving later
 * waits in its trigger and moves the repaired count by one. An UPDATE alone re-checks a row it
 * waited on but keeps its statement's snapshot for `count(*)` — and writes a stale count.
 */
export function recountLockSql(
  parent: string,
  counter: CounterDescriptionLike,
  after: string | null,
  last: string,
): SqlFragment {
  const from = raw(`select 1 from ${identifier(parent).text} p where `);
  const order = raw(` order by p.${identifier(counter.key).text} for no key update`);
  return sql`${from}${windowOf(counter, after, last)}${order}`;
}

/** The drifted rows of one window, for the report: key, stored and true count. */
export function recountDriftBatchSql(
  parent: string,
  counter: CounterDescriptionLike,
  after: string | null,
  last: string,
): SqlFragment {
  const select = raw(
    `select p.${identifier(counter.key).text}::text as "key", ` +
      `p.${identifier(counter.column).text} as "stored", ${truth(counter)} as "actual" ` +
      `from ${identifier(parent).text} p where `,
  );
  const drifted = raw(
    ` and p.${identifier(counter.column).text} is distinct from ${truth(counter)} ` +
      `order by p.${identifier(counter.key).text}`,
  );
  return sql`${select}${windowOf(counter, after, last)}${drifted}`;
}

/**
 * Sets every drifted counter of one window to the truth: one statement, one batch — only after
 * `recountLockSql` in the same transaction, or a concurrent writer's count is lost.
 */
export function recountBatchSql(
  parent: string,
  counter: CounterDescriptionLike,
  after: string | null,
  last: string,
): SqlFragment {
  const update = raw(
    `update ${identifier(parent).text} p set ${identifier(counter.column).text} = ${truth(counter)} where `,
  );
  const drifted = raw(
    ` and p.${identifier(counter.column).text} is distinct from ${truth(counter)}`,
  );
  return sql`${update}${windowOf(counter, after, last)}${drifted}`;
}
