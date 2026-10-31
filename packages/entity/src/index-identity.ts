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
 * A duplicate that asks for `concurrently: true` hands that ask to the one kept: dropping it would
 * silently build a hot table's index inside the migration's transaction after all.
 */
export function distinctIndexes(declared: readonly IndexDef[]): readonly IndexDef[] {
  return declared
    .filter(
      (index, position) =>
        declared.findIndex((other) => identity(other) === identity(index)) === position,
    )
    .map((index) =>
      index.concurrently !== true &&
      declared.some((other) => other.concurrently === true && identity(other) === identity(index))
        ? { ...index, concurrently: true as const }
        : index,
    );
}
