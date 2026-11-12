// Single responsibility: the bound on a preload — the ceiling a chain declares (or the default),
// resolved where `preload()` is called, and the refusal past it — plus the per-parent bound a
// `hasMany` may declare (`perParent`), resolved and refused at the same place. `preload.ts` reads
// under both.

import { describeValue } from '@ultimat3/schema';
import { describeCommand, EntityError } from './errors';
import { MAX_PAGE_SIZE } from './plan';
import type { Relation } from './relations';
import { relationNamed } from './relations';
import type { SortDirection, SortKey } from './tenancy';

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
  /**
   * A `hasMany` only: at most this many related rows per parent — "the last 3 messages of each
   * conversation" — read for the whole page in ONE statement (`LATERAL`, `latest-by.ts`), not one
   * `limit(n)` read per parent. Which n is `order` (a column of the related entity) in
   * `direction` (default `desc`); unnamed, the related key descending — newest first by uuid v7.
   */
  readonly perParent?: number;
  readonly order?: string;
  readonly direction?: SortDirection;
}

/** The per-parent bound a chain declared: how many, and which ones. */
export interface PerParent {
  readonly rows: number;
  readonly order: readonly SortKey[];
}

/** A relation as a chain named it: the edge, the ceiling it is read under, its per-parent bound. */
export type PreloadRelation = Relation & {
  readonly max: number;
  readonly perParent?: PerParent | undefined;
};

/** Whether a call stated anything a later call of the same relation replaces. */
const states = (options: PreloadOptions | undefined): boolean =>
  options?.max !== undefined || options?.perParent !== undefined;

const perParentOf = (
  entityName: string,
  relation: Relation,
  options: PreloadOptions | undefined,
): PerParent | undefined => {
  const rows = options?.perParent;
  const call = `${entityName}.preload('${relation.name}', { perParent })`;
  const refuse = (cause: string, fix: string): EntityError =>
    new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${call} — ${cause}`,
      fix: `${describeCommand(entityName)}   # ${fix}`,
    });
  if (rows === undefined) {
    if (options?.order === undefined && options?.direction === undefined) return undefined;
    throw refuse(
      'an order without perParent names no "first n": a whole relation attaches in full',
      `preload('${relation.name}', { perParent: <n>, order, direction })   # or drop { order, direction }: with no perParent the relation attaches in full`,
    );
  }
  if (relation.kind !== 'hasMany') {
    throw refuse(
      `'${relation.name}' is a belongsTo, which attaches one row per parent already`,
      `preload('${relation.name}')   # no { perParent }: a belongsTo attaches one row per parent`,
    );
  }
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > MAX_PAGE_SIZE) {
    throw refuse(
      `perParent is a whole number of rows, at least 1 and at most ${MAX_PAGE_SIZE}; got ${describeValue(rows)}`,
      `preload('${relation.name}', { perParent: 1 })   # a whole number of rows per parent, 1 to ${MAX_PAGE_SIZE}`,
    );
  }
  const order =
    options?.order === undefined
      ? []
      : [{ column: options.order, direction: options.direction ?? ('desc' as const) }];
  return { rows, order };
};

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
  const perParent = perParentOf(entityName, relation, options);
  return perParent === undefined ? { ...relation, max } : { ...relation, max, perParent };
};

/**
 * The chain's preloads after one more `preload()` call. A relation named twice is ONE statement,
 * and its bounds are one setting: a later call that STATES `max` or `perParent` replaces the
 * earlier one whole, exactly as a second `.limit()` replaces the first; a later call that states
 * neither leaves it. Name-only
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
  if (!states(options)) return held;
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
