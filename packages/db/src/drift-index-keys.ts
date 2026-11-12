// Single responsibility: drift's reading of an index's key parts past a plain column list — an
// expression key, per-key directions, INCLUDE, the operator class. Answers what the live index
// "is" when it differs from the declaration, in `changedIndex`'s words, or `null` when they agree.
// Split from `drift.ts` (ceiling); `compareIndexes` asks it after the method, before the columns.

import type { IndexDescription } from './introspect';

type Index = IndexDescription;

/**
 * The effective direction of every key, `asc` folded into `null` — `drift.ts`'s normalisation for
 * `order`, because `createIndex` writes `asc` and Postgres stores it as not-descending. `orders`
 * when present, else `order` repeated: a declared `['desc', 'desc']` and a catalog `order: 'desc'`
 * are the same index.
 */
const directions = (index: Index): readonly ('desc' | null)[] =>
  (index.orders ?? index.columns.map(() => index.order)).map((d) => (d === 'desc' ? 'desc' : null));

/** Whether this comparison owns the direction question — the plain `order` check yields to it. */
export const ownsDirection = (live: Index, expected: Index): boolean =>
  live.orders !== undefined || expected.orders !== undefined;

/** Whether this comparison owns the key-list question — an expression's text is the catalog's. */
export const ownsKeys = (expected: Index): boolean => expected.expression !== undefined;

/**
 * An expression key's TEXT is never compared — the catalog answers its rewriting
 * (`lower((email)::text)`), the predicate's reason in `drift.ts`. Its PRESENCE is: one key, marked
 * by the parentheses `introspect-index.ts` puts on every expression key.
 */
export function keyPartsChange(live: Index, expected: Index): string | null {
  if (ownsKeys(expected)) {
    const [only] = live.columns;
    if (live.columns.length !== 1 || only === undefined || !only.startsWith('(')) {
      return `covers (${live.columns.join(', ')}), not one expression`;
    }
  }
  if (ownsDirection(live, expected)) {
    const have = directions(live);
    if (have.join(',') !== directions(expected).join(',')) {
      return `orders its keys (${have.map((d) => d ?? 'asc').join(', ')})`;
    }
  }
  const include = (index: Index): string => (index.include ?? []).join(', ');
  if (include(live) !== include(expected)) {
    return include(live) === '' ? 'includes no columns' : `includes (${include(live)})`;
  }
  if ((live.operatorClass ?? null) !== (expected.operatorClass ?? null)) {
    return live.operatorClass === undefined
      ? 'uses the default operator class'
      : `uses ${live.operatorClass}`;
  }
  return null;
}
