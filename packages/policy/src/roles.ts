// Roles are sugar over permissions: a role grants a set, and may inherit others.
// Everything is expanded to a flat permission set before any policy runs, so the
// evaluator never has to reason about hierarchy — and a cycle is caught here, once.
// The per-actor flattening and its memo live in `grant-index.ts`; this file owns the map.
import type { Actor as CoreActor } from '@ultimat3/core';
import { roleRedefined } from './errors';
import { resourceOf } from './permissions';

/**
 * An **alias** of core's declaration, and nothing more (`As of 2026-08-19`) — so the actor
 * `userActor()` mints IS the actor a predicate decides about, with no spread and no second type.
 *
 * It used to be `CoreActor & PolicyActorFields`, a four-field interface declared here. Three of
 * those fields (`id`, `roles`, `orgId`) were already core's, so the intersection restated them;
 * `PolicyActorFields.orgId`'s `| null` never survived it at all, being intersected back to core's
 * `string | undefined`. The fourth, `permissions`, was the only real content — and declaring THAT
 * here is what made it unbuildable: core is tier 0, so `userActor({ permissions })` had no field
 * to land in and dropped the argument in silence. It now lives beside `roles` and `scopes` in
 * `@ultimat3/core`, where every actor is built, and this interface has nothing left to say.
 *
 * Same shape as `@ultimat3/entity`'s `MoneyValue`, aliased from `@ultimat3/schema` for the same
 * reason: one declaration, re-exported by the package whose public API talks about it.
 */
export type Actor = CoreActor;

export interface RoleDef {
  readonly grants: readonly string[];
  readonly inherits?: readonly string[];
  readonly description?: string;
}

export type RoleMap = Readonly<Record<string, RoleDef>>;

let roleMap: RoleMap = {};
let sites: Readonly<Record<string, string>> = {};
let generation = 0;

/**
 * Bumped by every write to the map. `grant-index.ts` memoises a flattened grant set against
 * it, the same shape `@ultimat3/entity`'s `relationMap()` uses against `registryGeneration()`:
 * a memo that cannot be invalidated by a later `defineRoles()` is a stale-authz bug.
 */
export const roleMapGeneration = (): number => generation;

/** Frames inside this file — never the answer to "who declared this role?". */
const INTERNAL_FRAME = /declarationSite|defineRoles/;

const declarationSite = (): string => {
  // Not a throw: the stack is the only place the declaring module's name exists at this point,
  // and `X_ROLE_REDEFINED` is unactionable without both sides of the collision.
  const stack = new Error().stack;
  if (stack === undefined) return 'unknown site';
  const frames = stack.split('\n').slice(1);
  const frame = frames.find((line) => !INTERNAL_FRAME.test(line)) ?? frames[0] ?? '';
  return frame.trim() === '' ? 'unknown site' : frame.trim();
};

/**
 * A role name is caller data, and an app's role map is a plain object literal — so `map['constructor']`
 * answers the `Object` FUNCTION rather than `undefined`, the `=== undefined` guard at the call site
 * never fires, and reading `.grants` off it throws a bare `TypeError` from inside `evaluate`. That is
 * an authz decision arriving at the error boundary as a 500 instead of a 403, for every request an
 * actor holding a role named `constructor`, `__proto__` or `toString` makes. Same discriminator
 * `@ultimat3/entity`'s `tenancy.ts` uses, for the same reason.
 */
const own = <V>(map: Readonly<Record<string, V>>, name: string): V | undefined =>
  Object.hasOwn(map, name) ? map[name] : undefined;

/**
 * `map[name] = value` is the same hazard writing: for `name === '__proto__'` it runs the setter on
 * `Object.prototype` and stores NO key, so the role would vanish between being merged and being
 * read back. `defineProperty` files an own key whatever the name spells.
 */
const put = <V>(map: Record<string, V>, name: string, value: V): void => {
  Object.defineProperty(map, name, { value, writable: true, enumerable: true, configurable: true });
};

const sameList = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
};

/**
 * A re-declaration of an identical role is a no-op, not a collision. That is what keeps the
 * `defineRoles({ ...roleDefinitions(), … })` spelling both tracked apps already use legal:
 * the spread hands every earlier role straight back.
 */
const sameDefinition = (left: RoleDef, right: RoleDef): boolean =>
  left === right ||
  (left.description === right.description &&
    sameList(left.grants, right.grants) &&
    sameList(left.inherits ?? [], right.inherits ?? []));

/**
 * MERGES into the app's one role map, and refuses a role two modules define differently.
 *
 * It used to replace, which made the map import-order-dependent: a second `defineRoles()` in a
 * new feature folder silently deleted the first module's roles, every `can()` still typechecked,
 * and every request 403'd on whichever bundler ordering CI happened to pick.
 */
export const defineRoles = <const M extends RoleMap>(map: M): M => {
  const site = declarationSite();
  const merged: Record<string, RoleDef> = { ...roleMap };
  const nextSites: Record<string, string> = { ...sites };
  for (const [role, definition] of Object.entries(map)) {
    const existing = own(merged, role);
    if (existing !== undefined && !sameDefinition(existing, definition)) {
      throw roleRedefined(role, own(sites, role) ?? 'unknown site', site);
    }
    put(merged, role, definition);
    put(nextSites, role, own(nextSites, role) ?? site);
  }
  roleMap = merged;
  sites = nextSites;
  generation += 1;
  return map;
};

export const roleDefinitions = (): RoleMap => roleMap;

/** Where each role was first declared. Read by `X_ROLE_REDEFINED`, and by nothing else. */
export const roleDeclarationSites = (): Readonly<Record<string, string>> => sites;

/** Test seam. */
export const clearRoles = (): void => {
  roleMap = {};
  sites = {};
  generation += 1;
};

/**
 * `clearRoles()`'s other half, taking what `roleDefinitions()` and `roleDeclarationSites()`
 * answer. `defineRoles()` runs at an app's MODULE scope and a module evaluates once per
 * `bun test` process, so a clear in one test file is permanent for every file after it — the
 * later file's `import` is a cache hit that declares nothing.
 *
 * `defineRoles()` cannot be the restore: it re-derives the declaration site from the CALLER's
 * stack, so every role would report this frame as its origin and `X_ROLE_REDEFINED` would name a
 * site no reader can open. The generation is bumped for `grant-index.ts`, whose per-actor memo is
 * invalidated by that number alone.
 */
export const restoreRoles = (map: RoleMap, declaredAt: Readonly<Record<string, string>>): void => {
  roleMap = { ...map };
  sites = { ...declaredAt };
  generation += 1;
};

/**
 * Depth-first expansion with a visited set: `owner -> admin -> editor` collapses to
 * one list, and `a -> b -> a` terminates instead of blowing the stack.
 */
export const expandRoles = (
  roles: readonly string[],
  map: RoleMap = roleMap,
): readonly string[] => {
  const seen = new Set<string>();
  const out = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const definition = own(map, name);
    if (definition === undefined) return;
    for (const grant of definition.grants) out.add(grant);
    for (const parent of definition.inherits ?? []) walk(parent);
  };
  for (const role of roles) walk(role);
  return [...out].sort();
};

/** `post:*` matches every verb on `post`; `*` matches everything. */
export const grantMatches = (grant: string, wanted: string): boolean => {
  if (grant === '*' || grant === wanted) return true;
  if (grant.endsWith(':*')) return resourceOf(grant) === resourceOf(wanted);
  return false;
};

/** For the `/_x` dashboard: which roles would satisfy a permission. */
export const rolesGranting = (permission: string, map: RoleMap = roleMap): readonly string[] =>
  Object.keys(map)
    .filter((role) => expandRoles([role], map).some((grant) => grantMatches(grant, permission)))
    .sort();
