// One admin MCP tool call, dispatched: the tool resolved against the actor's own allowed list, then
// handed to the CRUD call, action gate, batch or search its button uses. No transport here — that is
// `mcp.ts`, which runs this AS the caller; a direct `callAdminTool` is the same path.

import { invokeAdminAction } from './action-gate';
import { invokeRowAction } from './action-row';
import type { AdminApp } from './admin';
import { batchPlan, runAdminBatch } from './batch';
import { batchEnqueue } from './batch-job';
import {
  adminCreate,
  adminDestroy,
  adminDetail,
  adminList,
  adminUpdate,
  type CrudCtx,
  type CrudResult,
} from './crud';
import { AdminFilterInvalidError } from './errors';
import { type AskedFilter, checkedFilter } from './list-filters';
import { type AdminMcpTool, adminMcpTools } from './mcp-tools';
import type { AdminAction, AdminRow } from './registry';
import { adminSearch } from './search';
import type { ValidationIssue } from './validate';

export type McpInput = Readonly<Record<string, unknown>>;

export type AdminToolResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string; readonly reason: string };

const str = (input: McpInput, key: string): string => {
  const value = input[key];
  return typeof value === 'string' ? value : '';
};

const num = (input: McpInput, key: string): number | undefined => {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
};

const withoutKeys = (input: McpInput, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
};

/** The `where` argument as a list of asked filters; anything else in it is refused by name. */
const askedFilters = (where: unknown): readonly AskedFilter[] => {
  if (where === undefined || where === null) return [];
  const list: readonly unknown[] = Array.isArray(where) ? where : [where];
  return list.map((one) => {
    const bag = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>;
    const op = bag['op'];
    return {
      // A predicate with no `field` names the empty one, which no resource derives.
      field: typeof bag['field'] === 'string' ? bag['field'] : '',
      ...(typeof op === 'string' ? { op } : {}),
      value: bag['value'],
    };
  });
};

const actionByName = (app: AdminApp, name: string): AdminAction | undefined =>
  [...app.resources.flatMap((resource) => resource.actions), ...app.globalActions].find(
    (action) => action.name === name,
  );

/**
 * Dispatch one tool call. The tool must be in this actor's allowed list — resolving the name
 * against `adminMcpTools()` is what makes "the agent sees what it may do" true rather than
 * aspirational.
 */
export async function callAdminTool(
  app: AdminApp,
  ctx: CrudCtx,
  name: string,
  input: McpInput,
): Promise<AdminToolResult> {
  const tool = adminMcpTools(app, ctx).find((candidate) => candidate.name === name);
  // NOT dead code, and not the only gate: the registry's `visibleTo` predicate already hides
  // this tool from a caller who may not use it, so an MCP call cannot reach here refused.
  // Every other entry point (a direct `callAdminTool`, a future transport) can, so this stays
  // as defence in depth — the authz decision must not live only in the catalog filter.
  if (tool === undefined) {
    return {
      ok: false,
      error: 'X_ADMIN_TOOL_FORBIDDEN',
      reason: `tool "${name}" is not available to actor ${ctx.actor.id}`,
    };
  }
  return dispatch(app, ctx, tool, input);
}

async function dispatch(
  app: AdminApp,
  ctx: CrudCtx,
  tool: AdminMcpTool,
  input: McpInput,
): Promise<AdminToolResult> {
  if (tool.kind === 'search') {
    const result = await adminSearch({ term: str(input, 'term'), resources: app.resources, ctx });
    return { ok: true, data: result };
  }

  if (tool.kind === 'action') {
    const action = actionByName(app, tool.action ?? '');
    if (action === undefined) {
      return { ok: false, error: 'X_ADMIN_TOOL_FORBIDDEN', reason: 'action is not registered' };
    }
    const owner = app.resources.find((resource) => resource.actions.includes(action));
    const own = withoutKeys(input, ['id', 'ids', 'confirmation']);
    const confirmation = str(input, 'confirmation');
    // `ids`: the same tool as a batch — the bar's own path, row by row through the gate.
    if (owner !== undefined && action.batch !== undefined && Array.isArray(input['ids'])) {
      const ids = (input['ids'] as readonly unknown[]).filter(
        (one): one is string => typeof one === 'string',
      );
      const result = await runAdminBatch({
        resource: owner,
        action,
        ctx,
        selection: { kind: 'ids', ids },
        input: own,
        confirmation,
        ...(batchPlan(action) === null ? {} : { enqueue: batchEnqueue(app.basePath) }),
      });
      if (result.ok) return { ok: true, data: result };
      if (result.kind === 'invalid') return invalidIssues(result.issues);
      return { ok: false, error: 'X_ADMIN_DENIED', reason: result.decision.reason };
    }
    const id = str(input, 'id');
    // The row a row-level rule — and the action's own `when` — decides about, loaded through the
    // resource that OWNS the action: what the UI's button does. A global action names no row.
    const result =
      owner !== undefined && id !== ''
        ? await invokeRowAction({ resource: owner, action, id, ctx, input: own, confirmation })
        : await invokeAdminAction({
            action,
            input: { ...own, ...(id === '' ? {} : { id }) },
            actor: ctx.actor,
            authz: ctx.authz,
            audit: ctx.audit,
            requestId: ctx.requestId,
            subject: {
              ...(action.entity === undefined ? {} : { entity: action.entity }),
              ...(id === '' ? {} : { id }),
            },
            // The agent must echo the token, exactly as the UI makes an operator type it.
            confirmation,
          });
    if (result.ok) return { ok: true, data: result.value };
    if (result.kind === 'not-applicable') {
      return { ok: false, error: result.error.code, reason: result.error.cause };
    }
    if (result.kind === 'invalid') return invalidIssues(result.issues);
    return { ok: false, error: 'X_ADMIN_DENIED', reason: result.decision.reason };
  }

  const resource = app.resource(tool.entity ?? '');
  switch (tool.kind) {
    case 'list': {
      const limit = num(input, 'limit');
      const scope = str(input, 'scope');
      try {
        // `where` through the same validator a URL's `f.<field>` passes, and the scope by name:
        // an agent filters by exactly what an operator can, and the resource's row scope rides
        // the read inside `adminList` whatever the agent sends.
        const result = await adminList(resource, ctx, {
          cursor: str(input, 'cursor'),
          ...(limit === undefined ? {} : { limit }),
          ...(scope === '' ? {} : { scope }),
          filters: askedFilters(input['where']).map((asked) => checkedFilter(resource, asked)),
        });
        return result.ok
          ? { ok: true, data: result.page }
          : { ok: false, error: 'X_ADMIN_DENIED', reason: result.decision.reason };
      } catch (error) {
        if (!(error instanceof AdminFilterInvalidError)) throw error;
        return { ok: false, error: error.code, reason: error.cause };
      }
    }
    case 'read':
      return crudResult(await adminDetail(resource, ctx, str(input, 'id')));
    case 'create':
      return crudResult(await adminCreate(resource, ctx, input));
    case 'update':
      return crudResult(
        await adminUpdate(resource, ctx, str(input, 'id'), withoutKeys(input, ['id'])),
      );
    case 'delete':
      return crudResult(
        await adminDestroy(resource, ctx, str(input, 'id'), str(input, 'confirmation')),
      );
  }
}

/** The schema's issues, as the one string an agent's result carries. */
const invalidIssues = (issues: readonly ValidationIssue[]): AdminToolResult => ({
  ok: false,
  error: 'X_ADMIN_INVALID',
  reason: JSON.stringify(issues),
});

function crudResult(result: CrudResult<AdminRow>): AdminToolResult {
  if (result.ok) return { ok: true, data: result.row };
  if (result.kind === 'denied') {
    return { ok: false, error: 'X_ADMIN_DENIED', reason: result.decision.reason };
  }
  // No row by that id — or none this caller's row scope lets them see, which reads the same.
  if (result.kind === 'missing') {
    return { ok: false, error: 'X_ADMIN_INVALID', reason: 'no row has that id' };
  }
  // The update tool sends no form version: reached when an entity's declared lock refused the
  // write (X_ENTITY_STALE) because another write landed after this call read the row.
  if (result.kind === 'stale') {
    return { ok: false, error: 'X_ADMIN_INVALID', reason: 'the row changed since it was read' };
  }
  return invalidIssues(result.issues);
}
