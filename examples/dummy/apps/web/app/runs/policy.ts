/**
 * Authz for the runs feature: who may connect a site, start a run, watch it, answer its prompt and
 * cancel it. One definition per rule, evaluated identically by HTTP, the bearer mount, the live
 * subscription and the MCP tool.
 *
 * These rules read `actor.orgId`, not `memberOf(actor)`: a run is also started by a machine caller
 * holding an API key (`issueRunKey`), and a key is an org and a set of scopes with no membership
 * role. The grant is the role's or the key's; the predicate adds tenancy and nothing else.
 *
 * Predicates are synchronous — a live query re-evaluates one per subscriber on every change — so
 * a rule about a row reads `row`, which the surface loaded and passed in.
 */

import { can, definePermissions } from '@ultimat3/policy';

declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'run:read': true;
    'run:write': true;
    'run:key': true;
  }
}

export const runPermissions = definePermissions(['run:read', 'run:write', 'run:key']);

/** What every run rule decides on. Actions and the live query all put it in their `input`. */
export interface RunScope {
  readonly orgId: string;
}

/** The one row fact a run rule decides about: whose it is. */
export interface RunOwner {
  readonly orgId: string;
}

/** Structural: a member, an agent and an API key all carry their org the same way. */
const inOrg = (actor: { readonly orgId?: string | undefined } | null, orgId: string): boolean =>
  actor !== null && actor.orgId === orgId;

/**
 * Watching a run. `row === null` allows, as `feedRead` does and for its reason: the subscribe call
 * has no row and the tenancy line above already answered it; each delivered row is then checked
 * against the actor's own org.
 */
export const canRunRead = can<RunScope, RunOwner>(
  'run:read',
  ({ actor, input, row }) => inOrg(actor, input.orgId) && (row === null || inOrg(actor, row.orgId)),
);

/** Connecting a site and starting a run on one: a write inside the actor's own org. */
export const canRunWrite = can<RunScope>('run:write', ({ actor, input }) =>
  inOrg(actor, input.orgId),
);

/**
 * Answering a prompt and cancelling a run act on ONE run, so they decide about it. `row === null`
 * DENIES: it means no such run in the actor's org, and an absent fact is not a permission — a
 * run id is a guessable handle, and the event name an answer is published under is derived from
 * it and authorizes nothing.
 */
export const canRunAct = can<RunScope, RunOwner>(
  'run:write',
  ({ actor, input, row }) => inOrg(actor, input.orgId) && row !== null && inOrg(actor, row.orgId),
);

/** Issuing a machine caller's key is an admin's decision, inside their own org. */
export const canRunKey = can<RunScope>('run:key', ({ actor, input }) => inOrg(actor, input.orgId));

/** Revoking a key decides about THAT key: one issued in another org is a denial, never a miss. */
export const canRunKeyRevoke = can<RunScope, RunOwner>(
  'run:key',
  ({ actor, input, row }) => inOrg(actor, input.orgId) && row !== null && inOrg(actor, row.orgId),
);
