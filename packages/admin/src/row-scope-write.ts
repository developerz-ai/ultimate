// `rows`, applied to a WRITE: the row a create or an update would leave behind must satisfy the
// acting actor's row scope, or the write is refused before the repo is asked for it. The one place
// this package evaluates a predicate itself — a row that does not exist yet cannot be asked of the
// repo, which is how every READ answers the same question (`list-scope.ts`, `findRow`).

import type { AdminActor, AdminDecision } from './authz';
import type { AdminFilter, AdminRow } from './registry';
import type { AdminResource } from './resource';

/** The key a write whose result would sit outside the actor's row scope is refused with. */
export const ROW_OUT_OF_SCOPE_REASON = 'admin.error.row-out-of-scope';

export interface OutsideRowScope {
  readonly field: string;
  readonly op: AdminFilter['op'];
  /**
   * `false` when the predicate could not be decided exactly here — an ordering over text is a
   * collation's to answer — and the write is refused for that reason rather than for a mismatch.
   */
  readonly decidable: boolean;
}

const absent = (value: unknown): boolean => value === null || value === undefined;

/** An instant as milliseconds, whichever of the two shapes it travels in; `undefined` otherwise. */
const instantOf = (value: unknown): number | undefined => {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
};

/** Equal as the column's value: a `Date` against the ISO text a filter carries is one instant. */
const equal = (held: unknown, wanted: unknown): boolean => {
  if (held instanceof Date || wanted instanceof Date) {
    const a = instantOf(held);
    return a !== undefined && a === instantOf(wanted);
  }
  return typeof held === 'object' ? false : String(held) === String(wanted);
};

/** `-1 | 0 | 1` for two numbers or two instants; `undefined` for anything a collation orders. */
const ordered = (held: unknown, wanted: unknown): number | undefined => {
  const pair =
    typeof held === 'number' && typeof wanted === 'number'
      ? ([held, wanted] as const)
      : held instanceof Date
        ? ([instantOf(held), instantOf(wanted)] as const)
        : undefined;
  const [a, b] = pair ?? [];
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** `true` in scope, `false` out of it, `undefined` when this file cannot say. */
function satisfies(row: AdminRow, filter: AdminFilter): boolean | undefined {
  const held = Object.hasOwn(row, filter.field) ? row[filter.field] : undefined;
  if (filter.op === 'is-null') return absent(held) === (filter.value !== false);
  // SQL's three-valued logic: a NULL on either side matches nothing, `neq` included.
  if (absent(held) || absent(filter.value)) return false;
  switch (filter.op) {
    case 'eq':
      return equal(held, filter.value);
    case 'neq':
      return !equal(held, filter.value);
    case 'in':
      return Array.isArray(filter.value) && filter.value.some((one) => equal(held, one));
    case 'contains':
      // `LIKE` is case-sensitive and collation-free for a literal substring.
      return typeof held === 'string' ? held.includes(String(filter.value)) : undefined;
    default: {
      const order = ordered(held, filter.value);
      if (order === undefined) return undefined;
      if (filter.op === 'gt') return order > 0;
      if (filter.op === 'gte') return order >= 0;
      if (filter.op === 'lt') return order < 0;
      return order <= 0;
    }
  }
}

/** The first predicate `row` does not satisfy, or `null` when it satisfies every one. */
export function outsideRowScope(
  row: AdminRow,
  where: readonly AdminFilter[],
): OutsideRowScope | null {
  for (const filter of where) {
    const verdict = satisfies(row, filter);
    if (verdict === true) continue;
    return { field: filter.field, op: filter.op, decidable: verdict !== undefined };
  }
  return null;
}

/**
 * What a write would leave, judged against the acting actor's scope. `null` for a resource that
 * declares no `rows` — and for an actor whose scope is the empty conjunction, who sees every row.
 *
 * `touched` narrows an UPDATE to the predicates over the fields it writes: the stored row is
 * already inside the scope (the repo said so when it was loaded), so only a field the patch
 * changes can move it out — and a predicate this file cannot decide is then never asked about a
 * column nobody touched.
 */
export function writeOutsideScope(
  resource: AdminResource,
  actor: AdminActor,
  candidate: AdminRow,
  touched?: readonly string[],
): OutsideRowScope | null {
  if (resource.rowScope === undefined) return null;
  const scope = resource.rowScope(actor);
  return outsideRowScope(
    candidate,
    touched === undefined ? scope : scope.filter((filter) => touched.includes(filter.field)),
  );
}

/** The refusal a write outside the scope is answered and audited with. */
export function outOfScopeDecision(permission: string, outside: OutsideRowScope): AdminDecision {
  return {
    allowed: false,
    permission,
    reason: ROW_OUT_OF_SCOPE_REASON,
    trace: [
      outside.decidable
        ? `rows: ${outside.field} ${outside.op} is not satisfied by the row this write would leave`
        : `rows: ${outside.field} ${outside.op} cannot be decided before the write, so it is refused`,
    ],
  };
}
