// The admin's MCP surface, derived from the same resources and actions the UI renders and
// gated by the same authz. An agent therefore sees exactly the tools its actor could have
// clicked — no more, and never a tool whose call would then 403.
//
// Tool descriptions are literal English on purpose: they are protocol payload read by a
// model, not UI copy read by a person, so they are not `t()` keys.

import { adminPermissionForAction, decideAction, permissionsForAction } from './action-gate';
import type { AdminApp } from './admin';
import { type AdminDecision, decideAll } from './authz';
import { type CrudCtx, decideOperation, permissionsForOperation } from './crud';
import type { AdminFieldType } from './fields';
import { type AdminOperation, type AdminPermission, adminPermissionFor } from './permissions';
import type { AdminAction } from './registry';
import type { AdminResource } from './resource';

export type AdminToolKind = 'list' | 'read' | 'search' | 'create' | 'update' | 'delete' | 'action';

export interface AdminToolField {
  readonly name: string;
  readonly type: AdminFieldType;
  readonly required: boolean;
  /** The argument is a LIST of `type`: the list tool's `where` is a list of predicates. */
  readonly list?: true;
}

export interface AdminMcpTool {
  /** `admin.<entity>.<kind>`, or `admin.action.<name>`. Stable: agents cache tool names. */
  readonly name: string;
  readonly kind: AdminToolKind;
  readonly description: string;
  readonly entity: string | null;
  readonly action: string | null;
  readonly permissions: readonly string[];
  /**
   * The MCP scope a token must carry to call it: the admin-level permission it needs — `admin:read`
   * for a read and a `readonly` action, `admin:write` for a write, `admin:destroy` for a delete or a
   * destructive action. The connection's gate, checked before the actor's own policy.
   */
  readonly scope: AdminPermission;
  /** Destructive tools require the confirmation token; agents must read before they delete. */
  readonly destructive: boolean;
  readonly input: readonly AdminToolField[];
}

const CURSOR_FIELD: AdminToolField = { name: 'cursor', type: 'text', required: false };
const ID_FIELD: AdminToolField = { name: 'id', type: 'text', required: true };

/**
 * The envelope `mcp.ts` reads off an action call, declared because it was not: `input: []` renders
 * as `properties: {}, additionalProperties: false`, so a conforming client refuses to send any
 * argument at all — and then the server demands `confirmation` from the arguments it just told the
 * agent were invalid. `id` is optional (a global action has no subject); `confirmation` is required
 * exactly when the action is destructive, which is when `invokeAdminAction` compares it.
 *
 * The action's OWN input is not projected here and must not be: `AdminAction.input` is a Standard
 * Schema this package does not own, and inventing a field list for it would be a second, wrong
 * description of the same contract. `mcp.ts` leaves an action tool's schema OPEN instead, so the
 * action's own validation is the one that decides.
 */
const actionEnvelope = (action: AdminAction): readonly AdminToolField[] => [
  { name: 'id', type: 'text', required: false },
  // A batch action is the SAME tool, given a list of rows instead of one: run once per row through
  // the button's gate, answered with the counts the batch bar shows.
  ...(action.batch === undefined
    ? []
    : [{ name: 'ids', type: 'text', required: false, list: true } as const]),
  ...(action.destructive === true
    ? [{ name: 'confirmation', type: 'text', required: true } as const]
    : []),
];

/** What an agent reads about when and over what an action runs — the schema cannot say it. */
const actionDescription = (action: AdminAction): string =>
  [
    action.mcp?.description ?? `Run the ${action.name} action.`,
    action.when === undefined
      ? ''
      : ' Applies only to some rows: a row it does not apply to is refused with X_ADMIN_ACTION_NOT_APPLICABLE.',
    action.batch === undefined
      ? ''
      : ` Pass ids: [...] to run it once per row; the answer counts done, refused and failed${action.destructive === true ? ', and confirmation is "<entity>:<n> rows"' : ''}.`,
  ].join('');

const formFields = (resource: AdminResource): readonly AdminToolField[] =>
  resource.formFields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
  }));

/**
 * The list tool says what it filters by, because a schema cannot: `where` is a list of
 * `{ field, op?, value }` and the fields and scopes are this resource's own. The same names the
 * list screen's URL takes — one grammar, two transports.
 */
const listDescription = (resource: AdminResource): string => {
  const filters = resource.filters.map((field) => field.name);
  const scopes = resource.scopes.map((scope) => scope.name);
  return [
    `List ${resource.name} rows, cursor-paginated.`,
    filters.length === 0
      ? ''
      : ` where: [{ field, op?, value }] over ${filters.join(', ')}; op defaults per field.`,
    scopes.length === 0 ? '' : ` scope: one of ${scopes.join(', ')}.`,
  ].join('');
};

function toolFor(resource: AdminResource, op: AdminOperation): AdminMcpTool | null {
  switch (op) {
    case 'list':
      return {
        name: `admin.${resource.name}.list`,
        kind: 'list',
        description: listDescription(resource),
        entity: resource.name,
        action: null,
        permissions: permissionsForOperation(resource.permission, 'list'),
        scope: adminPermissionFor('list'),
        destructive: false,
        input: [
          CURSOR_FIELD,
          { name: 'limit', type: 'number', required: false },
          { name: 'scope', type: 'text', required: false },
          { name: 'where', type: 'json', required: false, list: true },
        ],
      };
    case 'detail':
      return {
        name: `admin.${resource.name}.read`,
        kind: 'read',
        description: `Read one ${resource.name} row by id.`,
        entity: resource.name,
        action: null,
        permissions: permissionsForOperation(resource.permission, 'detail'),
        scope: adminPermissionFor('detail'),
        destructive: false,
        input: [ID_FIELD],
      };
    case 'create':
      return {
        name: `admin.${resource.name}.create`,
        kind: 'create',
        description: `Create a ${resource.name} row. Validated by the entity's schema.`,
        entity: resource.name,
        action: null,
        permissions: permissionsForOperation(resource.permission, 'create'),
        scope: adminPermissionFor('create'),
        destructive: false,
        input: formFields(resource),
      };
    case 'update':
      return {
        name: `admin.${resource.name}.update`,
        kind: 'update',
        description: `Update fields of one ${resource.name} row.`,
        entity: resource.name,
        action: null,
        permissions: permissionsForOperation(resource.permission, 'update'),
        scope: adminPermissionFor('update'),
        destructive: false,
        input: [ID_FIELD, ...formFields(resource)],
      };
    case 'delete':
      return {
        name: `admin.${resource.name}.delete`,
        kind: 'delete',
        description: `Delete one ${resource.name} row. Requires confirmation "<entity>:<id>".`,
        entity: resource.name,
        action: null,
        permissions: permissionsForOperation(resource.permission, 'delete'),
        scope: adminPermissionFor('delete'),
        destructive: true,
        input: [ID_FIELD, { name: 'confirmation', type: 'text', required: true }],
      };
    case 'search':
      return null;
  }
}

/** One exposable tool and the decision that gates it, for whichever actor asks. */
interface ToolGate {
  readonly tool: AdminMcpTool;
  gate(ctx: CrudCtx): AdminDecision;
}

/**
 * The catalog and its gates, derived once. Two callers need different halves of it — the
 * transport needs every tool's name and schema before any caller exists, an actor needs the
 * subset it may call — and they must not be two derivations that can disagree.
 */
function toolGates(app: AdminApp): readonly ToolGate[] {
  const out: ToolGate[] = [];

  for (const resource of app.resources) {
    for (const op of resource.operations) {
      const tool = toolFor(resource, op);
      if (tool === null) continue;
      out.push({ tool, gate: (ctx) => decideOperation(resource, op, ctx) });
    }
    for (const action of resource.actions) {
      // The one surface in the framework that does NOT call `isMcpExposed`, on purpose: every
      // tool in this catalog is already gated on an admin permission, and the CRUD tools above
      // carry no `mcp` block at all — so opt-in here would list `admin.posts.delete` and hide
      // the button next to it. `expose: false` withdraws one. Stated in `wiki/Admin-Dashboard.md`
      // and in core's `mcp-exposure.ts`; nothing else may grow a second default.
      if (action.mcp?.expose === false) continue;
      out.push({
        tool: {
          name: `admin.action.${action.name}`,
          kind: 'action',
          description: actionDescription(action),
          entity: action.entity ?? null,
          action: action.name,
          permissions: permissionsForAction(action),
          scope: adminPermissionForAction(action),
          destructive: action.destructive === true,
          input: actionEnvelope(action),
        },
        gate: (ctx) => decideAction(action, ctx.actor, ctx.authz),
      });
    }
  }

  // Search is one tool over every resource, not one per entity: an agent looking for a row
  // should not have to fan out over the registry itself.
  out.push({
    tool: {
      name: 'admin.search',
      kind: 'search',
      description: 'Search every readable entity by its text fields. Returns ids and labels.',
      entity: null,
      action: null,
      permissions: permissionsForOperation('admin', 'search'),
      scope: adminPermissionFor('search'),
      destructive: false,
      input: [{ name: 'term', type: 'text', required: true }],
    },
    gate: (ctx) => decideAll(ctx.authz, permissionsForOperation('admin', 'search'), ctx.actor),
  });

  for (const action of app.globalActions) {
    // Same opt-out default as a resource action above, for the same reason.
    if (action.mcp?.expose === false) continue;
    out.push({
      tool: {
        name: `admin.action.${action.name}`,
        kind: 'action',
        description: actionDescription(action),
        entity: null,
        action: action.name,
        permissions: permissionsForAction(action),
        scope: adminPermissionForAction(action),
        destructive: action.destructive === true,
        input: actionEnvelope(action),
      },
      gate: (ctx) => decideAction(action, ctx.actor, ctx.authz),
    });
  }

  return out;
}

/** Every tool the surface could expose, ungated. The transport's `tools/list` payload. */
export function adminToolCatalog(app: AdminApp): readonly AdminMcpTool[] {
  return toolGates(app).map(({ tool }) => tool);
}

/** Every tool the surface could expose, each with the decision that would gate it. */
export function adminToolDecisions(
  app: AdminApp,
  ctx: CrudCtx,
): readonly { readonly tool: AdminMcpTool; readonly decision: AdminDecision }[] {
  return toolGates(app).map(({ tool, gate }) => ({ tool, decision: gate(ctx) }));
}

/** The tools this actor may call. The UI's visibility rule, applied to the MCP surface. */
export function adminMcpTools(app: AdminApp, ctx: CrudCtx): readonly AdminMcpTool[] {
  return adminToolDecisions(app, ctx)
    .filter(({ decision }) => decision.allowed)
    .map(({ tool }) => tool);
}
