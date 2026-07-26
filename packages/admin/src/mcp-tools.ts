// The admin's MCP surface, derived from the same resources and actions the UI renders and
// gated by the same authz. An agent therefore sees exactly the tools its actor could have
// clicked — no more, and never a tool whose call would then 403.
//
// Tool descriptions are literal English on purpose: they are protocol payload read by a
// model, not UI copy read by a person, so they are not `t()` keys.

import { decideAction, permissionsForAction } from './action-gate';
import type { AdminApp } from './admin';
import { type AdminDecision, decideAll } from './authz';
import { type CrudCtx, decideOperation, permissionsForOperation } from './crud';
import type { AdminFieldType } from './fields';
import type { AdminOperation } from './permissions';
import type { AdminResource } from './resource';

export type AdminToolKind = 'list' | 'read' | 'search' | 'create' | 'update' | 'delete' | 'action';

export interface AdminToolField {
  readonly name: string;
  readonly type: AdminFieldType;
  readonly required: boolean;
}

export interface AdminMcpTool {
  /** `admin.<entity>.<kind>`, or `admin.action.<name>`. Stable: agents cache tool names. */
  readonly name: string;
  readonly kind: AdminToolKind;
  readonly description: string;
  readonly entity: string | null;
  readonly action: string | null;
  readonly permissions: readonly string[];
  /** Destructive tools require the confirmation token; agents must read before they delete. */
  readonly destructive: boolean;
  readonly input: readonly AdminToolField[];
}

const CURSOR_FIELD: AdminToolField = { name: 'cursor', type: 'text', required: false };
const ID_FIELD: AdminToolField = { name: 'id', type: 'text', required: true };

const formFields = (resource: AdminResource): readonly AdminToolField[] =>
  resource.formFields.map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required,
  }));

function toolFor(resource: AdminResource, op: AdminOperation): AdminMcpTool | null {
  switch (op) {
    case 'list':
      return {
        name: `admin.${resource.name}.list`,
        kind: 'list',
        description: `List ${resource.name} rows, cursor-paginated, newest first.`,
        entity: resource.name,
        action: null,
        permissions: permissionsForOperation(resource.name, 'list'),
        destructive: false,
        input: [CURSOR_FIELD, { name: 'limit', type: 'number', required: false }],
      };
    case 'detail':
      return {
        name: `admin.${resource.name}.read`,
        kind: 'read',
        description: `Read one ${resource.name} row by id.`,
        entity: resource.name,
        action: null,
        permissions: permissionsForOperation(resource.name, 'detail'),
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
        permissions: permissionsForOperation(resource.name, 'create'),
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
        permissions: permissionsForOperation(resource.name, 'update'),
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
        permissions: permissionsForOperation(resource.name, 'delete'),
        destructive: true,
        input: [ID_FIELD, { name: 'confirmation', type: 'text', required: true }],
      };
    case 'search':
      return null;
  }
}

/** Every tool the surface could expose, each with the decision that would gate it. */
export function adminToolDecisions(
  app: AdminApp,
  ctx: CrudCtx,
): readonly { readonly tool: AdminMcpTool; readonly decision: AdminDecision }[] {
  const out: { tool: AdminMcpTool; decision: AdminDecision }[] = [];

  for (const resource of app.resources) {
    for (const op of resource.operations) {
      const tool = toolFor(resource, op);
      if (tool === null) continue;
      out.push({ tool, decision: decideOperation(resource, op, ctx) });
    }
    for (const action of resource.actions) {
      if (action.mcp?.expose === false) continue;
      out.push({
        tool: {
          name: `admin.action.${action.name}`,
          kind: 'action',
          description: action.mcp?.description ?? `Run the ${action.name} action.`,
          entity: action.entity ?? null,
          action: action.name,
          permissions: permissionsForAction(action),
          destructive: action.destructive === true,
          input: [],
        },
        decision: decideAction(action, ctx.actor, ctx.authz),
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
      destructive: false,
      input: [{ name: 'term', type: 'text', required: true }],
    },
    decision: decideAll(ctx.authz, permissionsForOperation('admin', 'search'), ctx.actor),
  });

  for (const action of app.globalActions) {
    if (action.mcp?.expose === false) continue;
    out.push({
      tool: {
        name: `admin.action.${action.name}`,
        kind: 'action',
        description: action.mcp?.description ?? `Run the ${action.name} action.`,
        entity: null,
        action: action.name,
        permissions: permissionsForAction(action),
        destructive: action.destructive === true,
        input: [],
      },
      decision: decideAction(action, ctx.actor, ctx.authz),
    });
  }

  return out;
}

/** The tools this actor may call. The UI's visibility rule, applied to the MCP surface. */
export function adminMcpTools(app: AdminApp, ctx: CrudCtx): readonly AdminMcpTool[] {
  return adminToolDecisions(app, ctx)
    .filter(({ decision }) => decision.allowed)
    .map(({ tool }) => tool);
}
