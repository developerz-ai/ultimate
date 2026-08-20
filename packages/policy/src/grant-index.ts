// One flattened grant set per actor, memoised for as long as the role map it was built from
// stays put. Why it earns a file: a live query evaluates policy PER SUBSCRIBER on every change
// event, and every `can()` clause asks this question — so an unmemoised expansion turned one
// write on a channel with 10k subscribers into 10k role-graph walks in a single tick.
import { type Permission, resourceOf } from './permissions';
import { type Actor, expandRoles, type RoleMap, roleDefinitions, roleMapGeneration } from './roles';

/**
 * The three shapes `grantMatches()` can take, pre-split so a lookup is a `Set.has` instead of a
 * scan: an exact grant, a `<resource>:*` wildcard, and the bare `*`. Equivalent to
 * `actorPermissions(actor).some((grant) => grantMatches(grant, permission))`, per grant kind.
 */
interface GrantIndex {
  readonly exact: ReadonlySet<string>;
  /** Resources covered by a `<resource>:*` grant. */
  readonly wildcards: ReadonlySet<string>;
  readonly all: boolean;
  /** Deduped and sorted, built once so `actorPermissions()` never sorts per clause. */
  readonly sorted: readonly string[];
}

interface CacheEntry {
  readonly map: RoleMap;
  readonly generation: number;
  readonly index: GrantIndex;
}

/**
 * Keyed on the actor OBJECT, never on its id: `@ultimat3/auth` mints a fresh, frozen actor per
 * request from a freshly-read user row, so the entry dies with the request and a revoked role
 * still takes effect on the very next one. Caching by id — or across requests — would trade that
 * property for the same allocations.
 */
const cache = new WeakMap<Actor, CacheEntry>();

const buildIndex = (actor: Actor, map: RoleMap): GrantIndex => {
  // `?? []` on both, though `Actor` declares them required and `userActor()` defaults them: this
  // takes an `Actor | null` from surfaces that hand it a value parsed out of JSON, and an authz
  // read that throws where it should have DENIED is the `testActor` defect one layer down.
  const exact = new Set<string>(actor.permissions ?? []);
  for (const grant of expandRoles(actor.roles ?? [], map)) exact.add(grant);
  const wildcards = new Set<string>();
  let all = false;
  for (const grant of exact) {
    if (grant === '*') all = true;
    else if (grant.endsWith(':*')) wildcards.add(resourceOf(grant));
  }
  return { exact, wildcards, all, sorted: [...exact].sort() };
};

const indexFor = (actor: Actor, map: RoleMap): GrantIndex => {
  const generation = roleMapGeneration();
  const hit = cache.get(actor);
  // The map is compared by reference as well as by generation, because both `actorHas()` and
  // `actorPermissions()` take an explicit map override that the generation counter never sees.
  if (hit !== undefined && hit.map === map && hit.generation === generation) return hit.index;
  const index = buildIndex(actor, map);
  cache.set(actor, { map, generation, index });
  return index;
};

/**
 * A COPY, per call. `readonly string[]` is compile-time only, so handing back `index.sorted` —
 * which is the per-actor authz cache itself — let any caller `push` a grant into it through a
 * widened reference and hold it for the life of that request. The list is small (an actor's own
 * grants) and this is not on `actorHas`'s path, which reads the `Set` and copies nothing.
 */
export const actorPermissions = (
  actor: Actor | null,
  map: RoleMap = roleDefinitions(),
): readonly string[] => (actor === null ? [] : [...indexFor(actor, map).sorted]);

export const actorHas = (
  actor: Actor | null,
  permission: Permission,
  map: RoleMap = roleDefinitions(),
): boolean => {
  if (actor === null) return false;
  const index = indexFor(actor, map);
  if (index.all || index.exact.has(permission)) return true;
  return index.wildcards.has(resourceOf(permission));
};
