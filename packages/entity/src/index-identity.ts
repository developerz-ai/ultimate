// When two index declarations are ONE index. Split out of `entity.ts` at the 500-line ceiling: a
// foreign key already indexes its column, and naming it again in `indexes` is not two indexes.

import type { IndexDef } from './types';

/**
 * WHAT the index is — never how it is built. `concurrently` is left out on purpose: it changes the
 * migration that builds an index, not the index, so a foreign key's own index and an `indexes:`
 * entry asking for the same one concurrently are still one index (`distinctIndexes` keeps the ask).
 */
const identity = (index: IndexDef): string =>
  [
    index.name,
    index.columns.join(','),
    index.unique,
    index.order ?? '',
    index.where ?? '',
    index.using ?? '',
  ].join('|');

/**
 * Every declared index once, in first-declared order.
 *
 * On the WHOLE definition and not on the name. With the name discriminator (`index-name.ts`) the
 * two rules agree exactly, so this is not a behaviour change on its own — it is which one FAILS
 * LOUDLY if the naming is ever weakened again. Matching on the name drops the second index in
 * silence, which is how two different partial indexes became one for three majors; matching on the
 * definition keeps both, and two `create index` statements sharing a name is `42P07` on the next
 * migration.
 *
 * A duplicate's ask about how to build is handed to the one kept: `true` over everything, since
 * dropping it would build a hot table's index inside a transaction after all, then an explicit
 * `false` over the default it opted out of.
 */
export function distinctIndexes(declared: readonly IndexDef[]): readonly IndexDef[] {
  return declared
    .filter(
      (index, position) =>
        declared.findIndex((other) => identity(other) === identity(index)) === position,
    )
    .map((index) => {
      const asks = declared
        .filter((other) => identity(other) === identity(index))
        .map((other) => other.concurrently);
      const ask = asks.includes(true) ? true : asks.includes(false) ? false : undefined;
      // `undefined` means no duplicate asked, so `index` itself asked nothing either.
      return ask === undefined || ask === index.concurrently
        ? index
        : { ...index, concurrently: ask };
    });
}
