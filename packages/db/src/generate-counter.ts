// Single responsibility: the trigger `references(…, { countedIn })` compiles to, and the
// recount that makes a counter true again. The trigger sits on the CHILD and moves the parent's
// integer in the same transaction, so `deleteWhere`, `upsertAll` and raw SQL keep it as an insert does.

import type { CounterDescriptionLike } from './entity-shape';
import { triggerInstall } from './generate-history';
import type { TriggerRecord } from './introspect';
import { identifier } from './sql';

/**
 * `ultimate_count_<crc32 of parent.column>`: per counter, because each body names its own tables,
 * and short, because a name past 63 bytes is truncated in silence and drift would compare the
 * untruncated one forever. CRC32 is Bun's, stable across processes and platforms.
 */
export function counterTriggerName(parent: string, counter: CounterDescriptionLike): string {
  const hash = Bun.hash.crc32(`${parent}.${counter.column}`).toString(16).padStart(8, '0');
  return `ultimate_count_${hash}`;
}

/** Whether a row image (`old`/`new`) is counted: it names a parent and is not soft-deleted. */
const counted = (image: 'old' | 'new', counter: CounterDescriptionLike): string =>
  `${image}.${identifier(counter.references).text} is not null` +
  (counter.softDelete === null
    ? ''
    : ` and ${image}.${identifier(counter.softDelete).text} is null`);

const bump = (parent: string, counter: CounterDescriptionLike, image: string, sign: string) =>
  `update ${identifier(parent).text} set ${identifier(counter.column).text} = ` +
  `${identifier(counter.column).text} ${sign} 1 where ${identifier(counter.key).text} = ` +
  `${image}.${identifier(counter.references).text};`;

/**
 * Old image out, new image in: an insert adds one, a delete takes one, a re-parent or a soft delete
 * moves it. Lock order is the PARENT row, so a hot parent serializes its writers — `countBy` plus a
 * cache is the alternative where that matters. `after … for each row`, so a refused write moves
 * nothing, and `update of` the two columns that can change the answer, so no other update pays.
 */
export function counterTrigger(parent: string, counter: CounterDescriptionLike): TriggerRecord {
  const name = counterTriggerName(parent, counter);
  const fn =
    `create or replace function ${identifier(name).text}() returns trigger language plpgsql as ` +
    `$counter$ begin if tg_op <> 'INSERT' and ${counted('old', counter)} then ` +
    `${bump(parent, counter, 'old', '-')} end if; if tg_op <> 'DELETE' and ` +
    `${counted('new', counter)} then ${bump(parent, counter, 'new', '+')} end if; ` +
    'return null; end; $counter$;';
  const watched = [counter.references, ...(counter.softDelete === null ? [] : [counter.softDelete])]
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
  ')';

/**
 * Sets every drifted counter to the truth. A migration adding a counter runs it once, so a table
 * that already holds rows starts true; `x db recount --write` runs it again, by key range.
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
