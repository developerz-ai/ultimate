// The route `load`s an exercise pass drives: every `app/` and `site/` file route that declares one,
// read off `@ultimat3/render`'s route table — the one list `x routes` and the manifest print. Who
// loads it (the route's permission, else a signed-in actor) and with which params (a seeded row's
// id, else the route's own `prerender()` sample) are decided here; the call is the runtime's own.

import type { Actor } from '@ultimat3/core';
import { renderThrowable } from '@ultimat3/core';
import { rolesGranting } from '@ultimat3/policy';
import type { RoleGrants } from './exercise-actor';
import { exerciseActorId } from './exercise-actor';
import { seededIds } from './exercise-input';
import type { SeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

export type RouteParamsValue = Readonly<Record<string, string>>;

/** One route as the pass drives it: what `load` is called with, by whom, and the call. */
export interface RouteLoadSubject {
  /** The URL pattern, `/posts/:id` — the record's name. */
  readonly path: string;
  /** The route file, relative to the app: what a finding points at. */
  readonly file: string;
  /** The pattern's params, in order. */
  readonly params: readonly string[];
  /** The route's `policy.permission`, when it declares one. */
  readonly permission?: string;
  /** `routeDataFor(config, ctx)`: the runtime's one way to resolve a page's data. */
  load(ctx: { readonly params: RouteParamsValue; readonly url: string }): Promise<unknown>;
  /** The route's `prerender()`, when it declares one: a sample of params it knows exist. */
  samples?(): Promise<readonly unknown[]>;
}

/** Each file route with a `load`, in the table's order. Loaded on demand: the barrel stays lean. */
export async function routeLoadSubjects(): Promise<readonly RouteLoadSubject[]> {
  const { routeDataFor, routeEntries } = await import('@ultimat3/render');
  return routeEntries()
    .filter((entry) => entry.config.load !== undefined)
    .map((entry): RouteLoadSubject => {
      const { prerender, policy } = entry.config;
      return {
        path: entry.path,
        file: entry.file,
        params: entry.pattern.keys,
        ...(policy === undefined ? {} : { permission: policy.permission }),
        load: (ctx) => routeDataFor(entry.config, ctx),
        ...(prerender === undefined ? {} : { samples: async () => prerender() }),
      };
    });
}

export type RouteActorChoice =
  | { readonly kind: 'actor'; readonly actor: Actor | null }
  | { readonly kind: 'refused'; readonly reason: string };

const holds = (actor: Actor, permission: string): boolean =>
  (actor.permissions ?? []).includes(permission) ||
  rolesGranting(permission).some((role) => (actor.roles ?? []).includes(role));

/**
 * The route's guard is a permission, never a policy: the first role holding it. With none, a
 * signed-in actor before the anonymous one — a page that branches on the viewer reads more rows.
 */
export function chooseRouteActor(
  permission: string | undefined,
  grants: RoleGrants,
  tenant: string,
): RouteActorChoice {
  const candidates = grants(tenant);
  const signedIn = candidates.filter((c) => c.actor !== null);
  const pick =
    permission === undefined
      ? (signedIn[0] ?? candidates[0])
      : signedIn.find((c) => c.actor !== null && holds(c.actor, permission));
  if (pick === undefined) {
    return {
      kind: 'refused',
      reason: `none of ${candidates.map((c) => c.name).join(', ') || 'the role grants'} holds ${permission ?? 'a role'}`,
    };
  }
  const { actor, name } = pick;
  return {
    kind: 'actor',
    actor: actor === null ? null : Object.freeze({ ...actor, id: exerciseActorId(name, tenant) }),
  };
}

/** A `prerender()` item as params: a bare string fills the one param, an entry carries its own. */
const sampleParams = (item: unknown, keys: readonly string[]): RouteParamsValue | undefined => {
  if (typeof item === 'string')
    return keys.length === 1 ? { [keys[0] as string]: item } : undefined;
  if (typeof item !== 'object' || item === null) return undefined;
  const nested = (item as { readonly params?: unknown }).params;
  const record = (typeof nested === 'object' && nested !== null ? nested : item) as Record<
    string,
    unknown
  >;
  const out: Record<string, string> = {};
  for (const key of keys) {
    // Own keys only: a param named `constructor` must never read the prototype's.
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    if (typeof value !== 'string') return undefined;
    out[key] = value;
  }
  return out;
};

export type RouteParamsChoice =
  | { readonly kind: 'params'; readonly params: RouteParamsValue }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * Each param bound to a seeded row's id the tenant sees (`:id` on `/posts/:id` is a `posts` key,
 * by the rule an input's `id` is bound by), else the route's first `prerender()` item.
 */
export async function routeParams(
  route: RouteLoadSubject,
  graph: SeedGraph,
  entities: readonly SeedEntity[],
  scope: { readonly tenant: string; readonly actorId?: string | undefined },
): Promise<RouteParamsChoice> {
  if (route.params.length === 0) return { kind: 'params', params: {} };
  const lookup = seededIds(graph, entities, { ...scope, subject: route.path });
  const bound: Record<string, string> = {};
  for (const key of route.params) {
    const hit = lookup(key);
    if (hit === undefined || typeof hit.value !== 'string') break;
    bound[key] = hit.value;
  }
  if (Object.keys(bound).length === route.params.length) return { kind: 'params', params: bound };
  const unbound = route.params.map((key) => `:${key}`).join(', ');
  if (route.samples === undefined) {
    return {
      kind: 'none',
      reason: `${unbound} names no seeded entity's key and the route declares no prerender() sample`,
    };
  }
  let items: readonly unknown[];
  try {
    items = await route.samples();
  } catch (error) {
    return { kind: 'none', reason: `its prerender() threw: ${renderThrowable(error)}` };
  }
  const sample = items.map((item) => sampleParams(item, route.params)).find(Boolean);
  return sample === undefined
    ? { kind: 'none', reason: `${unbound} is not filled by any item its prerender() answered` }
    : { kind: 'params', params: sample };
}

/** This machine: the origin a load is told, as a served request's `href` is absolute. */
const EXERCISE_ORIGIN = 'http://localhost';

/** The URL the load is told — absolute, as the runtime's `at.href` is: the pattern, params in. */
export const routeUrl = (path: string, params: RouteParamsValue): string =>
  EXERCISE_ORIGIN +
  path.replace(/[:*]([A-Za-z0-9_]+)/g, (whole, key: string) => {
    const value = Object.hasOwn(params, key) ? params[key] : undefined;
    if (value === undefined) return whole;
    // A catch-all keeps its slashes: `/docs/*path` with `a/b` is `/docs/a/b`.
    return whole.startsWith('*')
      ? value.split('/').map(encodeURIComponent).join('/')
      : encodeURIComponent(value);
  });
