/**
 * The whole admin dashboard. Screens, filters, forms and audit are derived from the entities;
 * authorisation is the app's existing policies, unchanged. Adding a feature adds an admin screen
 * and an MCP tool on the same day, not in a later quarter.
 *
 * Nothing here restates the schema: tenancy comes from each entity's own tenant column, the list
 * columns and filters come from the column metadata, and the searchable columns are every
 * non-sensitive text column — which already covers `posts.title`/`slug` and `members.email`/`name`.
 */

import { comments, likes, members, orgs, plans, posts } from '@postly/db';
// Through `api`, not through the feature module: registration is what stamps an export name onto
// its declaration, and the toolbar button IS that name. Importing the API surface is the boot.
import { api } from '@postly/web/api';
import type { Action } from '@ultimat3/action';
import {
  ADMIN_OPERATIONS,
  ADMIN_PERMISSIONS,
  type AdminAction,
  type AdminActor,
  type AdminEntity,
  adminMcp,
  defineAdmin,
  entityPermissionFor,
  policyAuthz,
} from '@ultimat3/admin';
import { isAnonymous, useContext } from '@ultimat3/core';
import { can, type Policy } from '@ultimat3/policy';
import type { StandardSchemaV1 } from '@ultimat3/schema';

const ENTITIES: readonly AdminEntity[] = [orgs, members, posts, comments, likes, plans];

/**
 * Every admin gate — the four `admin:*` ones and the per-entity `<entity>:read|write|delete` —
 * resolves to the one grant this app already defines for running the org. Owner-only, from
 * `shared/policies.ts`, so there is no second authz definition to keep in step: the dashboard is
 * one more caller of the same policy layer.
 */
const administer: Policy = can('org:administer');

const policies: Readonly<Record<string, Policy>> = Object.fromEntries([
  ...ADMIN_PERMISSIONS.map((permission) => [permission, administer]),
  ...ENTITIES.flatMap((entity) =>
    ADMIN_OPERATIONS.map((op) => [entityPermissionFor(entity.$name, op), administer]),
  ),
]);

/**
 * The dashboard has no session of its own: it reads the actor the app's pipeline already resolved
 * for this request. An admin that could mint its own identity would be a second front door.
 */
const currentActor = (): AdminActor | null => {
  const ctx = useContext();
  if (isAnonymous(ctx.actor)) return null;
  return { id: ctx.actor.id, roles: ctx.actor.roles, locale: ctx.locale, timeZone: ctx.tz };
};

/**
 * An `action` projected onto the dashboard's toolbar. The permission is the action's own, read off
 * the policy object rather than retyped, and the handler routes through the action's one callable
 * — so input parsing, the policy and the handler run exactly as they do over HTTP or MCP.
 */
const toolbarAction = <I extends StandardSchemaV1, O extends StandardSchemaV1>(
  action: Action<I, O>,
  entity: string,
): AdminAction => ({
  name: action.name,
  permission: action.policy.permissions[0] ?? 'admin:write',
  entity,
  input: action.input,
  ...(action.mcp === undefined ? {} : { mcp: action.mcp }),
  handle: ({ input }) => action.as(useContext().actor, input),
});

export const admin = defineAdmin({
  branding: { nameKey: 'admin.title' },
  entities: ENTITIES,
  actions: [
    toolbarAction(api.actions.publishPost, posts.$name),
    toolbarAction(api.actions.inviteMember, members.$name),
    toolbarAction(api.actions.upgradePlan, orgs.$name),
  ],
  auth: { actor: currentActor, authz: policyAuthz({ policies }) },
});

/** The user's own agents drive the user's own product, with the user's own permissions. */
export const adminAgents = adminMcp({ app: admin, actor: currentActor });
