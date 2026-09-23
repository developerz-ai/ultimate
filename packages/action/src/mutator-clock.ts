/**
 * The declaration-time proof `conflict: 'last-write-wins'` needs: every entity row the mutator
 * answers carries a NUMBER clock column the server writes (`updatedAt`, epoch ms). Without one,
 * core's `resolveConflict` can never prove the local row newer and the server row wins every time —
 * `'last-write-wins'` silently became `'server-wins'`, which `examples/dummy`'s `setTheme` shipped.
 */

import { projectionsIn } from '@ultimat3/entity';
import { MutatorClockMissingError } from './errors';

/** The field `resolveConflict` compares by default — the one rebase reads with no option set. */
export const CLOCK_FIELD = 'updatedAt';

/** Throws `X_MUTATOR_CLOCK_MISSING` unless every entity row in `output` has a number clock. */
export function assertConflictClock(output: unknown): void {
  const entities = projectionsIn(output);
  if (entities.length === 0) throw new MutatorClockMissingError(undefined, CLOCK_FIELD);
  for (const projection of entities) {
    const clock = projection.schema.properties?.[CLOCK_FIELD];
    if (clock?.kind !== 'number') throw new MutatorClockMissingError(projection.type, CLOCK_FIELD);
  }
}
