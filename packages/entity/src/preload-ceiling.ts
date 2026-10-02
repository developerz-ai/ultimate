// Single responsibility: the bound on a preload — the ceiling a chain declares (or the default),
// resolved where `preload()` is called, and the refusal past it. `preload.ts` reads under it.

import { describeValue } from '@ultimat3/schema';
import { EntityError } from './errors';
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
      cause: `${entityName}.preload('${relation.name}', { max }) — the ceiling is a whole number of related rows, at least one; got ${describeValue(max)}`,
      fix: `${entityName}.preload('${relation.name}', { max: ${MAX_PRELOADED_ROWS} })   # the default; declare the most rows one request may hold for this relation`,
    });
  }
  return { ...relation, max };
};

/**
 * Refused, never truncated: an array one row short reads as "these are the children", and nothing
 * at the call site could tell. The fix doubles the ceiling the chain declared, or names the read
 * that holds one page at a time.
 */
export const preloadTooMany = (entityName: string, relation: PreloadRelation): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.preload('${relation.name}') matched more than ${relation.max} ${relation.to} rows for one page — a preload holds every related row in memory, and that is past its ceiling`,
    fix: `${entityName}.preload('${relation.name}', { max: ${relation.max * 2} })   # or read them a page at a time: db.${relation.to}.andWhere('${relation.remoteKey}', 'in', ids).inBatches(1000)`,
  });
