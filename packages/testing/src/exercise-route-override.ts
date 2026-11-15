// What a route's `defineExercise(…, { routes })` entry changes about its call: the actor (declared,
// or the app's resolution of the one the pass seated) and the params (declared, or computed in the
// load's own request). Each function the app wrote runs in that request, so its reads see the
// route's tenant — and before the observed call, so its statements are never the load's.

import type { Actor } from '@ultimat3/core';
import { renderThrowable } from '@ultimat3/core';
import type { ExerciseOverrides } from './define-exercise';
import type { RouteExerciseEntry, RouteExerciseOverride } from './define-exercise-routes';
import type { RoleGrants } from './exercise-actor';
import { inTenant } from './exercise-actor';
import { withExerciseRequest } from './exercise-request';
import type { RouteActorChoice, RouteParamsValue } from './exercise-route-subjects';
import { chooseRouteActor } from './exercise-route-subjects';

/** The route's entry, by its URL pattern, or none. */
export const routeEntryFor = (
  overrides: ExerciseOverrides | undefined,
  path: string,
): RouteExerciseOverride | undefined => overrides?.routes?.get(path);

/** The entry as a call reads it: an `off` entry never reaches a call. */
export const liveEntry = (entry: RouteExerciseOverride | undefined): RouteExerciseEntry =>
  entry === undefined || 'off' in entry ? {} : entry;

/**
 * Who the pass seats before the entry speaks: a declared actor, moved into `tenant`; else the role
 * the guard admits — and for an actor FUNCTION whose guard no role holds, the first signed-in one,
 * which the function is there to complete.
 */
export function entryActorChoice(
  entry: RouteExerciseEntry,
  permission: string | undefined,
  grants: RoleGrants,
  tenant: string,
): RouteActorChoice {
  const { actor } = entry;
  if (actor !== undefined && typeof actor !== 'function') {
    return { kind: 'actor', actor: inTenant(actor, tenant) };
  }
  const chosen = chooseRouteActor(permission, grants, tenant);
  if (chosen.kind === 'actor' || actor === undefined) return chosen;
  return chooseRouteActor(undefined, grants, tenant);
}

export type EntryOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'threw'; readonly reason: string };

const threw = (field: string, error: unknown) => ({
  kind: 'threw' as const,
  reason: `its exercise.ts ${field} threw: ${renderThrowable(error)}`,
});

/** The actor the load runs as: the seated one, or what the entry's function made of it. */
export async function entryActor(
  label: string,
  entry: RouteExerciseEntry,
  seated: Actor | null,
): Promise<EntryOutcome<Actor | null>> {
  const resolve = entry.actor;
  if (typeof resolve !== 'function') return { kind: 'value', value: seated };
  try {
    const value = await withExerciseRequest(label, seated, async () => resolve(seated));
    return { kind: 'value', value };
  } catch (error) {
    return threw('actor', error);
  }
}

/** The entry's params, computed in the load's request when a function; `undefined`: the pass's. */
export async function entryParams(
  label: string,
  entry: RouteExerciseEntry,
  actor: Actor | null,
): Promise<EntryOutcome<RouteParamsValue> | undefined> {
  const { params } = entry;
  if (params === undefined) return undefined;
  if (typeof params !== 'function') return { kind: 'value', value: params };
  try {
    return { kind: 'value', value: await withExerciseRequest(label, actor, async () => params()) };
  } catch (error) {
    return threw('params', error);
  }
}

/** The query string the load's URL carries: the entry's (`?` added), computed in its request. */
export async function entrySearch(
  label: string,
  entry: RouteExerciseEntry,
  actor: Actor | null,
): Promise<EntryOutcome<string>> {
  const { search } = entry;
  if (search === undefined) return { kind: 'value', value: '' };
  try {
    const value =
      typeof search === 'function'
        ? await withExerciseRequest(label, actor, async () => search())
        : search;
    const bare = value.startsWith('?') ? value.slice(1) : value;
    return { kind: 'value', value: bare.length === 0 ? '' : `?${bare}` };
  } catch (error) {
    return threw('search', error);
  }
}
