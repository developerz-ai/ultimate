/**
 * The whole admin dashboard, and the only file that serves it: `x dev` and the container mount
 * every screen under `/admin` because this module declares it. Screens, filters, forms and audit
 * are derived from the entities and read through the app's typed handle; who may open each one is
 * the app's role map (`apps/web/shared/policies.ts`), so there is no admin-only policy.
 *
 * The run console's operator view is declared here with no page of its own: runs and connections
 * as resources, `running` / `failed` tabs with counts, a run's events as related rows, and a
 * `cancel` on each live run — one row, or a whole selection.
 */

import {
  comments,
  connections,
  db,
  LIVE_RUN_STATUSES,
  members,
  orgs,
  posts,
  runEvents,
  runs,
} from '@postly/db';
// Through `api`, not through the feature module: registration is what stamps an export name onto
// its declaration, and the toolbar button IS that name. Importing the API surface is the boot.
import { api } from '@postly/web/api';
import type { Action } from '@ultimat3/action';
import {
  type AdminAction,
  type AdminEntity,
  AdminPolicyMissingError,
  adminMcp,
  defineAdmin,
  requestActor,
} from '@ultimat3/admin';
import { useContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';

// `likes` (`postId, memberId`) and `plans` (`code, currency`) are not here: both key on more than
// one column, and `@ultimat3/admin` refuses a composite primary key (`X_ADMIN_FIELD_UNSUPPORTED`)
// rather than address a row by only the first member. `plans` is a pricing catalog an operator
// edits by migration, not a screen; `likes` is a high-volume join table with no admin-screen use.
const ENTITIES: readonly AdminEntity[] = [
  orgs,
  members,
  posts,
  comments,
  connections,
  runs,
  runEvents,
];

/** A run and its events are written by the job alone: an operator reads them and cancels. */
const READ_ONLY = ['list', 'detail', 'search'] as const;

/**
 * An `action` projected onto the dashboard's toolbar. The permission is the action's own, read off
 * the policy object rather than retyped, and the handler routes through the action's one callable
 * — so input parsing, the policy and the handler run exactly as they do over HTTP or MCP.
 *
 * `AdminAction.permission` is one string, so a composite policy (`and()`/`or()`, more than one
 * permission) or a policy-less action cannot be projected onto it honestly — this throws instead
 * of guessing a permission the action never declared.
 */
const toolbarAction = <I extends StandardSchemaV1, O extends StandardSchemaV1>(
  action: Action<I, O>,
  entity: string,
): AdminAction => {
  const [permission, ...rest] = action.policy.permissions;
  if (permission === undefined || rest.length > 0) {
    throw new AdminPolicyMissingError({ subject: action.name, kind: 'action' });
  }
  return {
    name: action.name,
    permission,
    entity,
    input: action.input,
    ...(action.mcp === undefined ? {} : { mcp: action.mcp }),
    handle: ({ input }) => action.as(useContext().actor, input),
  };
};

/**
 * Cancel a run from its row. The row's id IS the run id, so the handler is `cancelRun` — the same
 * action the console's button and an agent call, with its own `canRunAct` deciding again — and
 * the operator's own org, because a run is only ever cancelled inside the org that owns it.
 */
const cancelRun: AdminAction = {
  name: 'run.cancel',
  permission: 'run:write',
  entity: runs.$name,
  labelKey: 'admin.action.run.cancel',
  when: (row) => LIVE_RUN_STATUSES.some((status) => status === row['status']),
  batch: true,
  handle: ({ input }) => {
    const actor = useContext().actor;
    return api.actions.cancelRun.as(actor, {
      orgId: actor.orgId ?? '',
      runId: String(input['id']),
    });
  },
};

export const admin = defineAdmin({
  branding: { nameKey: 'admin.title' },
  entities: ENTITIES,
  // The app's typed handle, once: every resource reads through its own table there, so the CRUD
  // tools an agent is offered are tools that can answer.
  db,
  resources: {
    // The home page's tiles: one `count()` per visit each, so only the two tables that stay small —
    // an org's roster, and the orgs themselves (`count: true`, opt-in since sweep 10d).
    orgs: { count: true },
    members: { count: true },
    runs: {
      operations: READ_ONLY,
      listFields: ['status', 'code', 'connectionId', 'startedAt'],
      scopes: {
        running: { where: [{ field: 'status', op: 'eq', value: 'running' }], count: true },
        failed: { where: [{ field: 'status', op: 'eq', value: 'failed' }], count: true },
      },
      // What the run did, drawn as `run_events`' own list filtered to this run.
      related: ['run_events'],
    },
    run_events: { operations: READ_ONLY },
  },
  actions: [
    toolbarAction(api.actions.publishPost, posts.$name),
    toolbarAction(api.actions.inviteMember, members.$name),
    toolbarAction(api.actions.upgradePlan, orgs.$name),
    cancelRun,
  ],
});

/** The user's own agents drive the user's own product, with the user's own permissions. */
export const adminAgents = adminMcp({ app: admin, actor: () => requestActor().actor });
