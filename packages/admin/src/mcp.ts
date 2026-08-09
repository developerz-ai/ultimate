// The AI-first surface: the admin's resources and actions as MCP tools, wired through
// `defineAppMcp` so the user's agents drive the user's app. Same authz, same audit, same
// confirmation rules as the buttons — this file adds a transport, not a second back door.

import { agentActor } from '@ultimat3/core';
import {
  type AnyMcpTool,
  type AppMcp,
  defineAppMcp,
  type JsonSchema,
  jsonResult,
  type McpCaller,
  type McpToolResult,
  type ResolvedToken,
  type ToolArgs,
} from '@ultimat3/mcp';
import { invokeAdminAction } from './action-gate';
import type { AdminApp } from './admin';
import type { AdminActor } from './authz';
import {
  adminCreate,
  adminDestroy,
  adminDetail,
  adminList,
  adminUpdate,
  type CrudCtx,
  type CrudResult,
} from './crud';
import type { AdminFieldType } from './fields';
import {
  type AdminMcpTool,
  type AdminToolField,
  adminMcpTools,
  adminToolCatalog,
} from './mcp-tools';
import { confirmationToken } from './permissions';
import type { AdminAction, AdminRow } from './registry';
import { adminSearch } from './search';

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
    const id = str(input, 'id');
    const result = await invokeAdminAction({
      action,
      input: withoutKeys(input, ['confirmation']),
      actor: ctx.actor,
      authz: ctx.authz,
      audit: ctx.audit,
      requestId: ctx.requestId,
      subject: {
        ...(action.entity === undefined ? {} : { entity: action.entity }),
        ...(id === '' ? {} : { id }),
      },
      confirmation: str(input, 'confirmation'),
      // The agent must echo the token, exactly as the UI makes an operator type it.
      expectedConfirmation: confirmationToken(action.entity ?? 'admin', id),
    });
    return result.ok
      ? { ok: true, data: result.value }
      : { ok: false, error: 'X_ADMIN_DENIED', reason: result.decision.reason };
  }

  const resource = app.resource(tool.entity ?? '');
  switch (tool.kind) {
    case 'list': {
      const limit = num(input, 'limit');
      const result = await adminList(resource, ctx, {
        cursor: str(input, 'cursor'),
        ...(limit === undefined ? {} : { limit }),
      });
      return result.ok
        ? { ok: true, data: result.page }
        : { ok: false, error: 'X_ADMIN_DENIED', reason: result.decision.reason };
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

function crudResult(result: CrudResult<AdminRow>): AdminToolResult {
  if (result.ok) return { ok: true, data: result.row };
  return result.kind === 'denied'
    ? { ok: false, error: 'X_ADMIN_DENIED', reason: result.decision.reason }
    : { ok: false, error: 'X_ADMIN_INVALID', reason: JSON.stringify(result.issues) };
}

export interface AdminMcpOptions {
  readonly app: AdminApp;
  /** Resolve the MCP session's actor. The same hook the HTTP surface uses, never a bypass. */
  actor(session: { readonly token?: string }): Promise<AdminActor | null> | AdminActor | null;
  readonly requestId?: () => string;
}

/** A field type an agent can actually send. Anything richer is a JSON object on the wire. */
const JSON_TYPE: Readonly<Record<AdminFieldType, NonNullable<JsonSchema['type']>>> = {
  text: 'string',
  textarea: 'string',
  number: 'number',
  money: 'object',
  boolean: 'boolean',
  enum: 'string',
  date: 'string',
  timestamptz: 'string',
  timezone: 'string',
  locale: 'string',
  json: 'object',
  relation: 'string',
  file: 'string',
};

const inputSchema = (fields: readonly AdminToolField[]): JsonSchema => ({
  type: 'object',
  properties: Object.fromEntries(
    fields.map((field) => [field.name, { type: JSON_TYPE[field.type] }]),
  ),
  required: fields.filter((field) => field.required).map((field) => field.name),
  additionalProperties: false,
});

/**
 * `caller.actor` is whatever `resolveToken` returned, so the identity the tool runs as is the
 * one the session authenticated as — id and roles are all authz reads.
 */
const adminActorOf = (caller: McpCaller): AdminActor => ({
  id: caller.actor.id,
  roles: caller.actor.roles,
});

/**
 * The tool names one caller may call, memoized.
 *
 * WHY memoize: visibility is asked once per tool and each answer re-derives the whole
 * catalog, so an unmemoized `tools/list` costs O(tools²) authz decisions.
 *
 * WHY a `WeakMap` keyed on the caller OBJECT: an entry can never hand one caller another's
 * answer, and it is collected with the caller, so there is nothing to evict.
 *
 * Its LIFETIME is therefore the transport's, and the two transports differ:
 *
 * | Transport | `McpCaller` built | Cache grain |
 * |---|---|---|
 * | HTTP (`transport-http.ts`) | inside `route.handle`, per request | per request |
 * | stdio (`transport-stdio.ts`) | once, in `StdioTransportInput` | per connection |
 *
 * So over stdio a permission change made mid-connection is NOT observed until the client
 * reconnects. That is accepted, not overlooked: the stdio peer is the local developer's own
 * shell, which launched this process and already holds that developer's authority, and the
 * session is short and re-launched per editor/agent run. A connection-scoped catalog is the
 * intended grain there — an invalidation hook would add a second source of truth for
 * visibility to keep in sync with `adminMcpTools`, which is the drift this file avoids
 * everywhere else. Over HTTP, where a token can outlive a permission change, the grain is
 * already per request and the question does not arise.
 *
 * WHY keyed by app too: one process can mount two admins, and their catalogs differ.
 */
const allowedByCaller = new WeakMap<McpCaller, Map<AdminApp, ReadonlySet<string>>>();

function allowedToolNames(
  opts: AdminMcpOptions,
  requestId: () => string,
  caller: McpCaller,
): ReadonlySet<string> {
  const perApp = allowedByCaller.get(caller) ?? new Map<AdminApp, ReadonlySet<string>>();
  const cached = perApp.get(opts.app);
  if (cached !== undefined) return cached;

  const ctx = opts.app.ctx({ actor: adminActorOf(caller), requestId: requestId() });
  // `adminMcpTools` is the actor's allowed list — the same derivation the UI's buttons use.
  // Never a second decision written for MCP.
  const names: ReadonlySet<string> = new Set(adminMcpTools(opts.app, ctx).map(({ name }) => name));
  perApp.set(opts.app, names);
  allowedByCaller.set(caller, perApp);
  return names;
}

function toMcpTool(opts: AdminMcpOptions, requestId: () => string, tool: AdminMcpTool): AnyMcpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchema(tool.input),
    destructive: tool.destructive,
    // Visibility IS the gate: a tool this actor may not call is absent from `tools/list` and
    // answers ToolNotFound on call, never Forbidden — Forbidden would confirm the tool exists
    // and turn the catalog into something an agent can enumerate by probing names. The
    // predicate never sees call arguments, so visibility stays input-independent.
    visibleTo: (caller: McpCaller): boolean =>
      allowedToolNames(opts, requestId, caller).has(tool.name),
    async handle(args: ToolArgs, caller: McpCaller): Promise<McpToolResult> {
      const ctx = opts.app.ctx({ actor: adminActorOf(caller), requestId: requestId() });
      const result = await callAdminTool(opts.app, ctx, tool.name, args);
      if (result.ok) return jsonResult(result.data);
      // An expected outcome the model should reason about (a policy said no), not a
      // protocol error: the transport still answers 200 with the denial in the body.
      return { ...jsonResult({ error: result.error, reason: result.reason }), isError: true };
    },
  };
}

/**
 * Mount the admin as an app MCP server.
 *
 * The catalog is built once but answered per caller: every tool carries a `visibleTo`
 * predicate that re-derives that actor's allowed tools, so `tools/list` is answered per
 * caller — one `McpCaller` per HTTP request, one per stdio connection — and a tool the actor
 * may not use is ABSENT from it, while a direct call answers ToolNotFound, never Forbidden.
 * Forbidden would confirm the tool exists, leaking every entity name and operation to anyone
 * who probes. Every call still goes through `callAdminTool`, which re-checks the same allowed
 * list on dispatch, exactly as the UI refuses a button the actor may not click.
 */
export function adminMcp(opts: AdminMcpOptions): AppMcp {
  const requestId = opts.requestId ?? ((): string => crypto.randomUUID());

  return defineAppMcp({
    name: 'admin',
    tools: adminToolCatalog(opts.app).map((tool) => toMcpTool(opts, requestId, tool)),
    async resolveToken(token: string): Promise<ResolvedToken | null> {
      const actor = await opts.actor({ token });
      // `kind: 'agent'` — the same actor shape an agent gets everywhere else, so a policy
      // that distinguishes agents from people keeps working on this surface.
      return actor === null
        ? null
        : { actor: agentActor({ id: actor.id, roles: actor.roles ?? [] }), scopes: new Set() };
    },
  });
}
