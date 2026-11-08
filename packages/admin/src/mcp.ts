// The AI-first surface: the admin's resources and actions as MCP tools, wired through
// `defineAppMcp` so the user's agents drive the user's app. Same authz, same audit, same
// confirmation rules as the buttons — this file adds a transport, not a second back door.
// What one call DOES is `mcp-dispatch.ts`; this file is the catalog, the schemas and the caller.

import type { Actor } from '@ultimat3/core';
import { agentActor, ctxOf, hasContext, runWithContext, withChildContext } from '@ultimat3/core';
import {
  type AnyMcpTool,
  type AppMcp,
  defineAppMcp,
  exposedPrimitives,
  type JsonSchema,
  jsonResult,
  type McpCaller,
  type McpRequestFacts,
  type McpToolResult,
  type ResolvedToken,
  type ToolArgs,
} from '@ultimat3/mcp';
import type { AdminApp } from './admin';
import type { AdminActor } from './authz';
import type { AdminFieldType } from './fields';
import { callAdminTool } from './mcp-dispatch';
import { adminTokenScopes, adminToolScopes, includedToolScopes } from './mcp-scopes';
import { type AdminMcpTool, adminMcpTools, adminToolCatalog } from './mcp-tools';

/**
 * What a session token resolves to: the actor, and optionally the admin scopes the TOKEN was
 * issued for — narrower than the actor, never wider (the actor's policy still decides each tool).
 * `['admin:read']` is a read-only token: list, read, search and `readonly` actions. Absent: the
 * token is as strong as its actor (`adminTokenScopes`). Named `tokenScopes`, not `scopes`, because
 * core's `Actor.scopes` is a different thing (framework capabilities) and an actor handed straight
 * through must not have its `[]` read as "this token may do nothing".
 */
export interface AdminMcpActor extends AdminActor {
  readonly tokenScopes?: readonly string[];
}

export interface AdminMcpOptions {
  readonly app: AdminApp;
  /**
   * Resolve the MCP session's actor. The same hook the HTTP surface uses, never a bypass. `facts`:
   * how the request arrived (address, `Origin`) — what a development token is decided on.
   */
  actor(session: {
    readonly token?: string;
    readonly facts?: McpRequestFacts;
  }): Promise<AdminMcpActor | null> | AdminMcpActor | null;
  readonly requestId?: () => string;
  /** Mount path, `defineAppMcp`'s own. Default `/mcp`; an admin surface beside the app's says `/admin/mcp`. */
  readonly path?: string;
  /**
   * `'exposed'`: the app's own MCP tools here too, projected by `defineAppMcp` as on `/mcp`, each
   * under its kind's admin scope (`includedToolScopes`). Call `adminMcp` at module scope in
   * `apps/<app>/mcp.ts`: the mount refuses a catalog built before the scan ended (`X_MCP_INCLUDE_EARLY`).
   */
  readonly include?: 'exposed';
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
  // A sealed column travels as the text an agent sends. It is in no tool schema today — the
  // CRUD tools are built from `formFields`, which never holds one.
  secret: 'string',
};

/**
 * `additionalProperties` is closed for every derived CRUD tool — the admin knows every field an
 * entity has, so an argument outside that set is a mistake worth refusing at the client.
 *
 * It is OPEN for an action tool, and that is the whole point: the fields `mcp-tools.ts` declares
 * there are the admin's own envelope (`id`, `confirmation`), while the action's real input is its
 * own Standard Schema, which this package does not own and does not project. Closed would refuse
 * exactly the arguments the action needs; a made-up field list would describe a contract nobody
 * validates against. Open lets the action's own validation be the one that decides.
 */
const inputSchema = (tool: AdminMcpTool): JsonSchema => ({
  type: 'object',
  properties: Object.fromEntries(
    tool.input.map((field) => {
      // A field's own schema first: `JSON_TYPE` is the kind's scalar, and a `json()` column's value
      // is whatever its schema says — a blanket `object` refused every array and every `null`.
      const one = field.schema ?? { type: JSON_TYPE[field.type] };
      return [field.name, field.list === true ? { type: 'array', items: one } : one];
    }),
  ),
  required: tool.input.filter((field) => field.required).map((field) => field.name),
  additionalProperties: tool.kind === 'action',
});

/**
 * `caller.actor` is whatever `resolveToken` returned, so the identity the tool runs as is the
 * one the session authenticated as — id, roles and the TENANT are the authz reads.
 *
 * `orgId` rides the whole way or an org-scoped rule cannot fire: this hop rebuilt an `AdminActor`
 * from id and roles alone, so every `AdminAuthz` decision over `POST /mcp` was evaluated with
 * `actor.orgId === undefined` while the same app's UI path saw the real org — and
 * `adminList`/`adminSearch` add no tenant predicate of their own. Absent stays ABSENT rather than
 * becoming an explicit `undefined` key: `policy-bridge.ts` hands it to `userActor`, where
 * "single-tenant app" and "we dropped it" must not be the same value by accident.
 */
const adminActorOf = (caller: McpCaller): AdminActor => ({
  id: caller.actor.id,
  roles: caller.actor.roles,
  // Direct grants too: the pipeline decides on roles and `permissions` as one set.
  ...(caller.actor.permissions.length === 0 ? {} : { permissions: caller.actor.permissions }),
  ...(caller.actor.orgId === undefined ? {} : { orgId: caller.actor.orgId }),
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

/**
 * Run the call AS the MCP caller — the ambient actor, not only the `CrudCtx` one.
 *
 * `AdminApp.ctx()` builds a plain `CrudCtx` and never touches core's async context, so everything
 * deriving from `tryUseContext()` — entity's tenant guard, the query cache authority, the
 * jit-preload store — saw whatever actor the TRANSPORT's surrounding request installed rather than
 * the token's. Over `mcpHttpRoute` mounted in a pipeline that resolves a session cookie, an agent
 * token authorized as agent X while the repo reads ran as cookie-user Y's tenant; over stdio there
 * was no context at all, so `actorTenant` was `undefined` and `assertRowTenant` became a no-op and
 * an admin `create` could name any `orgId`. Same rule as `@ultimat3/mcp`'s `app-tool.ts`: the
 * caller is the actor for the WHOLE call, by construction rather than by two call sites agreeing.
 *
 * Two spellings, one rule, because there are two transports: a child context when a request is
 * already in flight (it keeps the parent's `requestId` and rebuilds the managed services against
 * the child's actor), a fresh ROOT context over stdio — where `withChildContext` would throw
 * `X_NO_CONTEXT` from its own `useContext()`.
 */
const asCaller = <T>(actor: Actor, requestId: string, run: () => Promise<T>): Promise<T> =>
  hasContext()
    ? withChildContext({ actor }, run)
    : runWithContext(ctxOf({ actor, requestId }), run);

function toMcpTool(opts: AdminMcpOptions, requestId: () => string, tool: AdminMcpTool): AnyMcpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchema(tool),
    destructive: tool.destructive,
    // Visibility IS the gate: a tool this actor may not call is absent from `tools/list` and
    // answers ToolNotFound on call, never Forbidden — Forbidden would confirm the tool exists
    // and turn the catalog into something an agent can enumerate by probing names. The
    // predicate never sees call arguments, so visibility stays input-independent.
    visibleTo: (caller: McpCaller): boolean =>
      allowedToolNames(opts, requestId, caller).has(tool.name),
    async handle(args: ToolArgs, caller: McpCaller): Promise<McpToolResult> {
      const id = requestId();
      const ctx = opts.app.ctx({ actor: adminActorOf(caller), requestId: id });
      const result = await asCaller(caller.actor, id, () =>
        callAdminTool(opts.app, ctx, tool.name, args),
      );
      if (result.ok) return jsonResult(result.data);
      // An expected outcome the model should reason about (a policy said no), not a
      // protocol error: the transport still answers 200 with the denial in the body.
      //
      // `code` is for the AUDIT line only and never reaches the wire — it is already in the
      // body above. Without it the server classified every refusal here as `policy-denied` at
      // `warn`, so a malformed `create` sat in the bucket a prober's name walk is alerted from,
      // beside real denials. `X_ADMIN_INVALID` is a client misreading a schema that publishes a
      // `type` per field and nothing else; `X_ADMIN_DENIED` is authz, and stays outcome 3.
      return {
        ...jsonResult({ error: result.error, reason: result.reason }),
        isError: true,
        code: result.error,
      };
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
  const catalog = adminToolCatalog(opts.app);

  const own = adminToolScopes(catalog);

  return defineAppMcp({
    name: 'admin',
    tools: catalog.map((tool) => toMcpTool(opts, requestId, tool)),
    ...(opts.path === undefined ? {} : { path: opts.path }),
    // The app's tools are `defineAppMcp`'s projection, never a copy; the scopes read the same registry.
    ...(opts.include === undefined ? {} : { include: opts.include }),
    // The connection gate: each tool needs its admin-level permission as a token scope, checked
    // by the registry BEFORE the actor's policy. A stdio host builds its caller's scopes with
    // `adminTokenScopes`, as `resolveToken` does below.
    scopes: opts.include === 'exposed' ? includedToolScopes(exposedPrimitives(), own) : own,
    async resolveToken(token: string, facts: McpRequestFacts): Promise<ResolvedToken | null> {
      const actor = await opts.actor({ token, facts });
      // `kind: 'agent'` — the same actor shape an agent gets everywhere else, so a policy
      // that distinguishes agents from people keeps working on this surface.
      //
      // `orgId` is carried because this is the FIRST of the two hops between the app's resolver
      // and an authz decision (`adminActorOf` is the second): dropped here, the tenant is gone
      // before any tool, catalog filter or child context can see it, and nothing downstream can
      // put it back.
      return actor === null
        ? null
        : {
            actor: agentActor({
              id: actor.id,
              roles: actor.roles ?? [],
              permissions: actor.permissions ?? [],
              orgId: actor.orgId,
            }),
            scopes: adminTokenScopes(actor.tokenScopes),
          };
    },
  });
}
