// The actor type both surfaces agree on. Policies read this and nothing else, so authz cannot
// disagree between HTTP, live queries, jobs and MCP.
import { expandRoles, grantMatches } from '@ultimat3/policy';
import { roles } from './roles';

export interface Actor {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
}

/**
 * What this actor may DO, answered from the declared role map. Never `actor.roles.includes('admin')`:
 * a role-name comparison is a second authz rule, and it goes stale the moment a role is renamed or
 * a grant moves to another role. `grantMatches` is what reads a `post:*` wildcard as one.
 */
export const holds = (actor: Actor | null, permission: string): boolean =>
  actor !== null &&
  expandRoles(actor.roles, roles).some((grant) => grantMatches(grant, permission));
