// Single responsibility: the bound on a preload — the ceiling a chain declares (or the default),
// resolved where `preload()` is called, and the refusal past it. `preload.ts` reads under it.

import { describeValue } from '@ultimat3/schema';
import { describeCommand, EntityError } from './errors';
import { MAX_PAGE_SIZE } from './plan';
import type { Relation } from './relations';
import { relationNamed } from './relations';

/**
 * How many related rows ONE relation may attach to one page when the chain declares no ceiling of
 * its own: the largest page a read may ask for. A preload holds every related row in memory, and
 * a `hasMany` paged until the relation was exhausted — a parent with a million children was a
 * million rows from a chain that named no number.
 */
export const MAX_PRELOADED_ROWS = MAX_PAGE_SIZE;

export interface PreloadOptions {
  /** The ceiling for this relation on this chain. Past it the read is refused, never truncated. */
  readonly max?: number;
}

/** A relation as a chain named it: the edge, and the ceiling it is read under. */
export type PreloadRelation = Relation & { readonly max: number };

/**
 * The relation a `preload()` call names, resolved on the chain — an unknown name and a ceiling
 * that is not a count both fail where they were written, not one page later.
 */
export const preloadOf = (
  entityName: string,
  name: string,
  options: PreloadOptions | undefined,
): PreloadRelation => {
  const relation = relationNamed(entityName, name);
  const max = options?.max === undefined ? MAX_PRELOADED_ROWS : options.max;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${entityName}.preload('${relation.name}', { max }) — the ceiling is a whole number of related rows, at least one; got ${describeValue(max)}. Write .preload('${relation.name}', { max: ${MAX_PRELOADED_ROWS} }) on that chain — the default — or the most rows one request may hold for this relation`,
      fix: `${describeCommand(entityName)}   # the entity whose chain preloads '${relation.name}': correct the { max } on that call`,
    });
  }
  return { ...relation, max };
};

/**
 * The chain's preloads after one more `preload()` call. A relation named twice is ONE statement,
 * and its ceiling is one setting: a later call that STATES `max` replaces the earlier one, exactly
 * as a second `.limit()` replaces the first; a later call that states none leaves it. Name-only
 * dedup kept the first and silently dropped a stricter ceiling written after it.
 */
export const preloadsWith = (
  held: readonly PreloadRelation[],
  entityName: string,
  name: string,
  options: PreloadOptions | undefined,
): readonly PreloadRelation[] => {
  const resolved = preloadOf(entityName, name, options);
  if (!held.some((one) => one.name === resolved.name)) return [...held, resolved];
  if (options?.max === undefined) return held;
  return held.map((one) => (one.name === resolved.name ? resolved : one));
};

/**
 * Refused, never truncated: an array one row short reads as "these are the children", and nothing
 * at the call site could tell. The cause names both ways out — the doubled ceiling to write on the
 * chain, or the read that holds one page at a time.
 */
export const preloadTooMany = (entityName: string, relation: PreloadRelation): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.preload('${relation.name}') matched more than ${relation.max} ${relation.to} rows for one page — a preload holds every related row in memory, and that is past its ceiling. Raise it on that chain with .preload('${relation.name}', { max: ${relation.max * 2} }), or read ${relation.to} a page at a time, filtered on ${relation.remoteKey}, with inBatches(1000)`,
    fix: `${describeCommand(entityName)}   # the entity whose chain preloads '${relation.name}': raise its { max }, or page ${relation.to} with inBatches()`,
  });
