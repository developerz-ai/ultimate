// Roles are sugar over permissions: a role grants a set, and may inherit others.
// Everything is expanded to a flat permission set before any policy runs, so the
// evaluator never has to reason about hierarchy — and a cycle is caught here, once.
import type { Actor as CoreActor } from '@ultimat3/core';
import { type Permission, resourceOf } from './permissions';

/**
 * The fields policy evaluation reads off an actor. `Actor` itself is core's; these
 * are authz roles ("editor", "owner"), not core's runtime `Role` ("web", "worker").
 */
export interface PolicyActorFields {
  readonly id: string;
  readonly roles?: readonly string[] | undefined;
  /** Direct grants, bypassing roles. Used by service tokens. */
  readonly permissions?: readonly string[] | undefined;
  readonly orgId?: string | null | undefined;
}

export type Actor = CoreActor & PolicyActorFields;

export interface RoleDef {
  readonly grants: readonly string[];
  readonly inherits?: readonly string[];
  readonly description?: string;
}

export type RoleMap = Readonly<Record<string, RoleDef>>;

let roleMap: RoleMap = {};

export const defineRoles = <const M extends RoleMap>(map: M): M => {
  roleMap = map;
  return map;
};

export const roleDefinitions = (): RoleMap => roleMap;

/** Test seam. */
export const clearRoles = (): void => {
  roleMap = {};
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
    const definition = map[name];
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

export const actorPermissions = (
  actor: Actor | null,
  map: RoleMap = roleMap,
): readonly string[] => {
  if (actor === null) return [];
  const direct = actor.permissions ?? [];
  const fromRoles = expandRoles(actor.roles ?? [], map);
  return [...new Set([...direct, ...fromRoles])].sort();
};

export const actorHas = (
  actor: Actor | null,
  permission: Permission,
  map: RoleMap = roleMap,
): boolean => actorPermissions(actor, map).some((grant) => grantMatches(grant, permission));

/** For the `/_x` dashboard: which roles would satisfy a permission. */
export const rolesGranting = (permission: string, map: RoleMap = roleMap): readonly string[] =>
  Object.keys(map)
    .filter((role) => expandRoles([role], map).some((grant) => grantMatches(grant, permission)))
    .sort();
