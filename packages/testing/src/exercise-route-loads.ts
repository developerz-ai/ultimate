// One route `load` in the exercise pass: called once in its own seeded tenant, inside the room, as
// the runtime calls it (`routeDataFor` in a request as the chosen actor) — its statements counted,
// its busiest call held to the statement ceiling, then swept at 2 and 8 rows a table and planned
// beside the primitives. A page read is a read like a query's: an N+1 in it is the same red.

import type { Actor } from '@ultimat3/core';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import type { ExerciseOverrides } from './define-exercise';
import type { RoleGrants } from './exercise-actor';
import { seatActorUsers } from './exercise-actor-user';
import type {
  ExerciseEffect,
  ExerciseRecord,
  ExerciseRoom,
  Observation,
  ProofMs,
} from './exercise-report';
import { withExerciseRequest } from './exercise-request';
import {
  entryActor,
  entryActorChoice,
  entryParams,
  entrySearch,
  liveEntry,
  routeEntryFor,
} from './exercise-route-override';
import type { RouteLoadSubject, RouteParamsValue } from './exercise-route-subjects';
import { routeParams, routeUrl } from './exercise-route-subjects';
import type { StatementCeilingProof } from './exercise-statement-ceiling';
import { judgeStatementCeiling } from './exercise-statement-ceiling';
import { actorRowsOf, seated } from './exercise-sweeps';
import type { PlanProof } from './plan-sweep';
import type { ScaleProof } from './scale-sweep';
import type { ScaleSubject } from './scale-sweep-run';
import type { SeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

/** What one route's `load` did in the pass. `name` is the URL pattern; `file` the route file. */
export interface RouteLoadRecord {
  readonly kind: 'route';
  readonly name: string;
  readonly file: string;
  readonly outcome: 'reached' | 'refused' | 'unreached' | 'off';
  readonly code?: string;
  readonly reason?: string;
  readonly statements: number;
  readonly effects: readonly ExerciseEffect[];
  readonly ms: number;
  readonly statementCeiling?: StatementCeilingProof;
  /** Reached with no statement and no effect, and the entry says why that is right. */
  readonly empty?: string;
  readonly plans?: PlanProof;
  readonly scale?: ScaleProof;
  readonly proofMs?: ProofMs;
}

/** The room's and the sweeps' key: never a primitive's, whose names are identifiers. */
export const routeLabel = (path: string): string => `route:${path}`;

/** The pass's options, as far as choosing who loads a page goes. */
export interface RouteCallOptions {
  readonly entities: readonly SeedEntity[];
  readonly overrides?: ExerciseOverrides;
  readonly roles: RoleGrants;
}

/** The page's data, resolved as a render resolves it, in a request as `actor`. */
export const callRoute = (
  route: RouteLoadSubject,
  call: RouteCallInput,
  actor: Actor | null,
): Promise<unknown> =>
  withExerciseRequest(routeLabel(route.path), actor, () =>
    route.load({ params: call.params, url: `${routeUrl(route.path, call.params)}${call.search}` }),
  );

/** What one load is handed: its params and the query string its URL carries (`''`, or `?…`). */
export interface RouteCallInput {
  readonly params: RouteParamsValue;
  readonly search: string;
}

/**
 * Who loads `route` in `tenant` of `graph`, and with which params — or none. The route's
 * `defineExercise` entry speaks first (`exercise-route-override.ts`); the pass picks the rest.
 */
export async function routeCall(
  route: RouteLoadSubject,
  options: RouteCallOptions,
  graph: SeedGraph,
  tenant: string,
): Promise<
  | ({ readonly actor: Actor | null } & RouteCallInput)
  | { readonly refused?: true; readonly reason: string }
> {
  const entry = liveEntry(routeEntryFor(options.overrides, route.path));
  const label = routeLabel(route.path);
  const chosen = entryActorChoice(entry, route.permission, options.roles, tenant);
  if (chosen.kind === 'refused') return { refused: true, reason: chosen.reason };
  const base = seated(chosen.actor, tenant, actorRowsOf(options, graph));
  // A user, as a request's actor always is: its `x_users` row before any call.
  await seatActorUsers([base]);
  const resolved = await entryActor(label, entry, base);
  if (resolved.kind === 'threw') return { reason: resolved.reason };
  const actor = resolved.value;
  if (actor !== base) await seatActorUsers([actor]);
  const search = await entrySearch(label, entry, actor);
  if (search.kind === 'threw') return { reason: search.reason };
  const declared = await entryParams(label, entry, actor);
  if (declared?.kind === 'threw') return { reason: declared.reason };
  if (declared !== undefined) return { actor, params: declared.value, search: search.value };
  const params = await routeParams(route, graph, options.entities, { tenant, actorId: actor?.id });
  if (params.kind === 'none') return { reason: params.reason };
  return { actor, params: params.params, search: search.value };
}

const unreachedBy = (seen: Observation<unknown>) => {
  if ('error' in seen) {
    const { error } = seen;
    return {
      outcome: 'unreached' as const,
      ...(isUltimateError(error) ? { code: error.code } : {}),
      reason: `its load threw: ${renderThrowable(error)}`,
    };
  }
  const [host] = seen.observed.refusedHosts;
  return host === undefined
    ? undefined
    : { outcome: 'unreached' as const, reason: `its load called ${host}, which the pass seals` };
};

/** `route`'s load once, in `tenant`: the record before the sweeps add their proofs. */
export async function exerciseRouteLoad(
  route: RouteLoadSubject,
  options: RouteCallOptions,
  at: { readonly graph: SeedGraph; readonly tenant: string; readonly room: ExerciseRoom },
): Promise<RouteLoadRecord> {
  const none = { kind: 'route' as const, name: route.path, file: route.file };
  const empty = { ...none, statements: 0, effects: [], ms: 0 };
  const entry = routeEntryFor(options.overrides, route.path);
  if (entry !== undefined && 'off' in entry) {
    return { ...empty, outcome: 'off', reason: entry.off.trim() };
  }
  const call = await routeCall(route, options, at.graph, at.tenant);
  if ('reason' in call) {
    return {
      ...empty,
      outcome: call.refused === true ? 'refused' : 'unreached',
      reason: call.reason,
    };
  }
  const started = performance.now();
  const seen = await at.room.observe(routeLabel(route.path), () =>
    callRoute(route, call, call.actor),
  );
  const ms = Math.round(performance.now() - started);
  const { observed } = seen;
  const ran = { ...none, statements: observed.statements, effects: observed.effects, ms };
  const statementCeiling = judgeStatementCeiling([observed], liveEntry(entry).statements);
  const failed = unreachedBy(seen);
  const why = liveEntry(entry).empty;
  const vacuous = failed === undefined && ran.statements === 0 && ran.effects.length === 0;
  return {
    ...ran,
    ...(failed ?? { outcome: 'reached' as const }),
    ...(vacuous && why !== undefined ? { empty: why.trim() } : {}),
    ...(statementCeiling === undefined ? {} : { statementCeiling }),
  };
}

/** The route as the scale sweep calls it: `input` is what `routeCall` bound at each size. */
export const routeScaleSubject = (route: RouteLoadSubject): ScaleSubject => ({
  name: routeLabel(route.path),
  call: async (input, actor) => {
    await callRoute(route, input as RouteCallInput, actor);
    return {};
  },
});

/**
 * Every route after the primitives, each in the tenant pair after theirs (`pairGraph`'s rule: its
 * cost is its pair's), and the sweep's view of them: a scale subject and its sized-call recipe.
 */
export async function runRouteLoads(
  routes: readonly RouteLoadSubject[],
  options: RouteCallOptions,
  at: {
    readonly view: (index: number) => SeedGraph;
    readonly tenant: (index: number) => string;
    readonly room: ExerciseRoom;
  },
): Promise<readonly RouteLoadRecord[]> {
  const records: RouteLoadRecord[] = [];
  for (const [i, route] of routes.entries()) {
    const graph = at.view(i);
    records.push(
      await exerciseRouteLoad(route, options, { graph, tenant: at.tenant(i), room: at.room }),
    );
  }
  return records;
}

/** The sized-call recipe for a route label, or `undefined` when the label is not a route's. */
export async function routeSizedCall(
  routes: readonly RouteLoadSubject[],
  options: RouteCallOptions,
  at: { readonly label: string; readonly graph: SeedGraph; readonly tenant: string },
): Promise<{ readonly actor: Actor | null; readonly input: unknown } | undefined> {
  const route = routes.find((one) => routeLabel(one.path) === at.label);
  if (route === undefined) return undefined;
  const call = await routeCall(route, options, at.graph, at.tenant);
  return 'reason' in call
    ? undefined
    : { actor: call.actor, input: { params: call.params, search: call.search } };
}

/** The sweeps' key for a record of either kind: a route's label, else the primitive's own. */
export const sweepLabel =
  (label: (record: ExerciseRecord) => string) =>
  (record: ExerciseRecord | RouteLoadRecord): string =>
    record.kind === 'route' ? routeLabel(record.name) : label(record);

/** The routes whose load answered, as the scale sweep calls them. */
export const reachedRouteSubjects = (
  routes: readonly RouteLoadSubject[],
  records: readonly RouteLoadRecord[],
): readonly ScaleSubject[] =>
  routes
    .filter((route) => records.some((r) => r.name === route.path && r.outcome === 'reached'))
    .map(routeScaleSubject);

/** The swept records apart again: the primitives' list stays what the pass always returned. */
export function splitRouteRecords(records: readonly (ExerciseRecord | RouteLoadRecord)[]): {
  readonly primitives: readonly ExerciseRecord[];
  readonly routes: readonly RouteLoadRecord[];
} {
  const primitives: ExerciseRecord[] = [];
  const routes: RouteLoadRecord[] = [];
  for (const record of records) {
    if (record.kind === 'route') routes.push(record);
    else primitives.push(record);
  }
  return { primitives, routes };
}
