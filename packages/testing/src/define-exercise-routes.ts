// A route `load`'s entry in `defineExercise(…, { routes: { '/posts/:id': { … } } })`: the params
// and the actor a page needs that a seeded id and a role cannot give it, its statement ceiling, why
// a load that reads nothing is right (`empty`), or why it cannot run (`off`). Keyed by the URL
// pattern `x routes` prints; an unknown one is refused when the pass runs.

import type { Actor } from '@ultimat3/core';
import { finiteCount, renderCauseValue, renderFixLiteral, UltimateError } from '@ultimat3/core';
import type { ExerciseStatementCeiling } from './exercise-statement-ceiling';

export type RouteParamsRecord = Readonly<Record<string, string>>;

/** What a route's load runs with — each field optional, the pass's own pick where omitted. */
export interface RouteExerciseEntry {
  /**
   * The params, or a function computing them — awaited inside the load's own request as its
   * actor, so `useContext().actor.orgId` names the seeded tenant and `db()` reads its rows.
   */
  readonly params?: RouteParamsRecord | (() => Promise<RouteParamsRecord> | RouteParamsRecord);
  /**
   * The query string the load's URL carries (`response_type=code&…`, a leading `?` optional), or a
   * function computing it in the load's request — a page that reads `url`, not params.
   */
  readonly search?: string | (() => Promise<string> | string);
  /**
   * Who loads it: an actor (moved into the route's tenant), or a function of the actor the pass
   * seated — awaited in its request — answering the actor as the app's request boundary would
   * resolve it (its facts: the member row, the org).
   */
  readonly actor?: Actor | null | ((seated: Actor | null) => Promise<Actor | null> | Actor | null);
  /** The ceiling one load is held to, `STATEMENTS_MAX` when omitted. */
  readonly statements?: ExerciseStatementCeiling;
  /** Why a load that sends no statement and has no effect is right: its proofs are vacuous. */
  readonly empty?: string;
}

export type RouteExerciseOverride = RouteExerciseEntry | { readonly off: string };

/** The one refusal for a stated reason left blank: the skip, or the exception, is silent. */
export const blankWhy = (where: string, field: string, paste: string): UltimateError =>
  new UltimateError({
    code: 'X_CONTRACT_EXERCISE_UNDECLARED',
    cause: `defineExercise() gives ${renderCauseValue(where)} a blank ${field}, so the exception is silent`,
    fix: `${paste}   # in apps/web/exercise.ts`,
  });

const blankText = (value: unknown): boolean =>
  typeof value !== 'string' || value.trim().length === 0;

/** `empty: '<why>'` on any entry, primitive or route: present means stated. */
export function checkEmptyWhy(where: string, empty: unknown, paste: string): void {
  if (empty !== undefined && blankText(empty)) throw blankWhy(where, 'empty why', paste);
}

/** Each route entry, its reasons stated and its ceiling a whole count ≥ 1. */
export function routeEntries(
  routes: Readonly<Record<string, RouteExerciseOverride>>,
): ReadonlyMap<string, RouteExerciseOverride> {
  const entries = new Map<string, RouteExerciseOverride>();
  for (const [path, entry] of Object.entries(routes)) {
    const at = renderFixLiteral(path, '<pattern>');
    const paste = (field: string): string =>
      `defineExercise({}, { routes: { ${at}: { ${field} } } })`;
    if ('off' in entry) {
      if (blankText(entry.off)) throw blankWhy(path, 'off reason', paste("off: '<why>'"));
    } else {
      checkEmptyWhy(path, entry.empty, paste("empty: '<why it reads nothing>'"));
      if (entry.statements !== undefined) {
        finiteCount('defineExercise()', `${path}.statements.max`, entry.statements.max, 1);
        if (blankText(entry.statements.why)) {
          throw blankWhy(path, 'statements why', paste("statements: { max: <n>, why: '<why>' }"));
        }
      }
    }
    entries.set(path, entry);
  }
  return entries;
}

/**
 * Every route entry names a registered route's pattern — checked when the pass runs, the route
 * table full. `X_DECLARATION_UNKNOWN`, the code every unknown name answers; the cause lists them.
 */
export function assertRoutesKnown(
  overrides: { readonly routes?: ReadonlyMap<string, RouteExerciseOverride> } | undefined,
  registered: readonly string[],
): void {
  const known = new Set(registered);
  const unknown = [...(overrides?.routes?.keys() ?? [])].filter((path) => !known.has(path)).sort();
  if (unknown.length === 0) return;
  const listed = [...known].sort();
  throw new UltimateError({
    code: 'X_DECLARATION_UNKNOWN',
    cause: `defineExercise() routes name ${unknown.map((path) => renderCauseValue(path)).join(', ')}, which no app/ or site/ route with a load is (registered: ${listed.length === 0 ? 'none' : renderCauseValue(listed.join(', '))})`,
    fix: 'x routes --json   # then rename or remove the entry under routes in apps/web/exercise.ts',
    meta: { unknown, registered: listed },
  });
}
