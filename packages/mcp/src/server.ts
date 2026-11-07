// The MCP server: JSON-RPC dispatch over a tool registry, a resource registry and a
// prompt list. Transport-independent — `handle(body, caller)` takes an already-parsed body
// and an already-resolved caller, and returns a response or `null` for a notification.
// Both transports (http, stdio) and every test drive this one function.

import type { Clock, ErrorAudience } from '@ultimat3/core';
import { fixFor } from '@ultimat3/core';
import { outcomeForResult } from './audit';
import type { McpAuditHook, McpAuditor } from './audit-hook';
import { LOG_ONLY_AUDITOR, mcpAuditor } from './audit-hook';
import {
  McpProtocolError,
  McpScopeDeniedError,
  McpTenantRequiredError,
  TOOL_UNKNOWN_FIX,
} from './errors';
import { metaCall } from './meta-call';
import { META_UNKNOWN_FIX } from './meta-errors';
import type { McpResourceGroups, McpSurfaceOption, MetaResource } from './meta-surface';
import { MetaSurface } from './meta-surface';
import { promptListEntry, promptsGet, visiblePrompts } from './prompts-get';
import type { McpEra } from './protocol-era';
import {
  classifyBody,
  discoverResult,
  eraOf,
  initializeResult,
  METHODS,
  stamped,
  unsupportedVersion,
} from './protocol-era';
import type {
  AnyMcpTool,
  McpCaller,
  McpToolResult,
  McpVerbClass,
  ToolListEntry,
  ToolResolution,
} from './registry';
import { ToolRegistry } from './registry';
import type { McpPrompt, McpResource, McpResourceSource } from './resources';
import { ResourceRegistry } from './resources';
import { resourcesRead } from './server-resources';
import type { McpInstructions, McpServerVoice } from './server-voice';
import { instructionsFor, invalidArgsResult } from './server-voice';
import { buildTenantActor, stripTenantArgs } from './tenant';
import type { McpTenantOption } from './tenant';
import { admitted, thrownResponse } from './tool-thrown';
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse, McpWire, ServerInfo } from './wire';
import {
  defaultServerInfo,
  errorResponse,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isJsonRpcRequest,
  isNotification,
  METHOD_NOT_FOUND,
  messageUnitOf,
  paramsOf,
  resultResponse,
} from './wire';

export type { McpWire } from './wire';

export interface McpServerInput {
  readonly tools?: readonly AnyMcpTool[];
  readonly resources?: readonly McpResource[];
  /** Resources listed per caller (a tenant's own docs), after the fixed ones. */
  readonly resourceSources?: readonly McpResourceSource[];
  readonly prompts?: readonly McpPrompt[];
  readonly serverInfo?: ServerInfo;
  /** `'flat'` (the default): one tool per primitive. See `McpSurfaceOption`. */
  readonly surface?: McpSurfaceOption | undefined;
  /** The meta catalog's resources. Required with a surface that can be `'meta'`. */
  readonly groups?: McpResourceGroups | undefined;
  /**
   * `initialize`'s `instructions`: how to use this server, for a client that injects it into the
   * model's context (Claude Code does; many clients do not — never load-bear on it). A function
   * answers per caller population — a staff surface and a customer one read different advice —
   * and a function that throws or answers anything but a non-empty string sends none.
   */
  readonly instructions?: McpInstructions | undefined;
  /**
   * Whose `fix:` line a refusal carries. `'developer'` (the default, and the dev server's): the
   * fix the author wrote — `x policy explain …`, a declaration to edit. `'caller'`: the error's
   * `callerFix` where it declares one — what a REMOTE agent can do about it. `defineAppMcp`
   * serves `'caller'`.
   */
  readonly errorAudience?: ErrorAudience | undefined;
  /** Every gate decision as data, after its log line — see `audit-hook.ts`. The route reads it too. */
  readonly onAudit?: McpAuditHook | undefined;
  /** Stamps each `onAudit` event's `at`. */
  readonly clock?: Clock | undefined;
  /**
   * Present when this app hosts many orgs under one token: ONE arg names the tenant each call
   * runs for, resolved against the app's membership hook before anything sees the call — which
   * is why no tool below ever declares it. Absent = a single-tenant app, byte for byte as before.
   */
  readonly tenant?: McpTenantOption | undefined;
}

export function mcpServer(input: McpServerInput = {}): McpServer {
  const tools = new ToolRegistry().registerAll(input.tools ?? []);
  const resources = new ResourceRegistry().registerAll(input.resources ?? []);
  for (const source of input.resourceSources ?? []) resources.addSource(source);
  const meta = MetaSurface.build({
    surface: input.surface,
    groups: input.groups,
    tools: input.tools ?? [],
  });
  return new McpServer(
    tools,
    resources,
    input.prompts ?? [],
    input.serverInfo ?? defaultServerInfo(),
    meta,
    { instructions: input.instructions, errorAudience: input.errorAudience ?? 'developer' },
    input.onAudit === undefined && input.clock === undefined
      ? LOG_ONLY_AUDITOR
      : mcpAuditor({ onAudit: input.onAudit, clock: input.clock }),
    input.tenant,
  );
}

export class McpServer {
  readonly tools: ToolRegistry;
  readonly resources: ResourceRegistry;
  private readonly prompts: readonly McpPrompt[];
  private readonly serverInfo: ServerInfo;
  /** `undefined` for a flat-only server — every existing app, byte for byte. */
  private readonly meta: MetaSurface | undefined;
  private readonly voice: McpServerVoice;
  /** Where every decision is audited — the log line, then `onAudit`. Public for the HTTP route. */
  readonly audit: McpAuditor;
  /** Tenant option, `undefined` on a single-tenant app — see `McpServerInput.tenant`. */
  private readonly tenant: McpTenantOption | undefined;

  constructor(
    tools: ToolRegistry,
    resources: ResourceRegistry,
    prompts: readonly McpPrompt[],
    serverInfo: ServerInfo,
    meta?: MetaSurface,
    voice: McpServerVoice = { errorAudience: 'developer' },
    audit: McpAuditor = LOG_ONLY_AUDITOR,
    tenant?: McpTenantOption,
  ) {
    this.tools = tools;
    this.resources = resources;
    this.prompts = prompts;
    this.serverInfo = serverInfo;
    this.meta = meta;
    this.voice = voice;
    this.audit = audit;
    this.tenant = tenant;
  }

  async handle(
    body: unknown,
    caller: McpCaller,
    wire?: McpWire | undefined,
  ): Promise<JsonRpcResponse | null> {
    // A batch is legal JSON-RPC 2.0 and this server does not walk one: one call, one answer, one
    // rate-limit class. Refused BY NAME rather than falling through to the envelope check below —
    // an array is not an envelope, so it did, and a client sending a batch got the same bare
    // `-32600` as `{ not: 'jsonrpc' }` with no word that batching was the problem. Measured
    // through one adopter's `POST /mcp` on 2026-09-07. The `message` is the same on every wire;
    // only the fix names the unit — `POST <path>` as mounted, or a line — and only when the
    // transport said which it is.
    if (Array.isArray(body)) {
      return protocolRefusal(
        'a JSON-RPC batch (an array of requests) is not supported: send one request per message',
        new McpProtocolError({
          cause: 'the body is a JSON-RPC batch, and this server answers one request per message',
          fix: `send one request per ${messageUnitOf(wire)} — a batch is never walked, so its calls did not run`,
        }),
      );
    }
    if (!isJsonRpcRequest(body)) {
      return protocolRefusal(
        'not a JSON-RPC 2.0 request envelope',
        new McpProtocolError({
          cause: 'the body is not a JSON-RPC 2.0 request envelope',
        }),
      );
    }
    // Notifications get no answer at all; the transport replies 202 with an empty body.
    if (isNotification(body)) return null;
    const id = body.id ?? null;
    // The era is per request (`protocol-era.ts`): a modern one is answered statelessly and stamped.
    const era = eraOf(body);
    if (typeof era !== 'string') return unsupportedVersion(id, era.unsupported);
    const answer = METHODS[era].includes(body.method)
      ? await this.answer(id, body, caller, era)
      : undefined;
    if (answer === undefined) {
      return errorResponse(id, METHOD_NOT_FOUND, `method not found: ${body.method}`, {
        supported: METHODS[era],
      });
    }
    return era === 'modern' ? stamped(answer, body.method, this.serverInfo) : answer;
  }

  /** One method of `METHODS[era]`, answered. */
  private async answer(
    id: JsonRpcId,
    body: JsonRpcRequest,
    caller: McpCaller,
    era: McpEra,
  ): Promise<JsonRpcResponse | undefined> {
    switch (body.method) {
      case 'initialize':
        return resultResponse(
          id,
          initializeResult(
            paramsOf(body),
            this.serverInfo,
            instructionsFor(this.voice.instructions, caller),
          ),
        );
      case 'server/discover':
        return resultResponse(id, discoverResult(instructionsFor(this.voice.instructions, caller)));
      // Empty on both eras until an adopter declares a template; `resources` is advertised.
      case 'resources/templates/list':
        return resultResponse(id, { resourceTemplates: [] });
      case 'tools/list':
        return resultResponse(id, { tools: this.list(caller) });
      case 'tools/call':
        return this.toolsCall(body, caller);
      case 'resources/list':
        return resultResponse(id, { resources: await this.resources.listFor(caller) });
      case 'resources/read':
        return resourcesRead(
          { resources: this.resources, audit: this.audit, audience: this.voice.errorAudience },
          body,
          caller,
          era,
        );
      // MCP's keep-alive: an empty result, which clients treat as "still here".
      case 'ping':
        return resultResponse(id, {});
      case 'prompts/list':
        return resultResponse(id, {
          prompts: visiblePrompts(this.prompts, caller).map(promptListEntry),
        });
      case 'prompts/get':
        return promptsGet(this.prompts, id, paramsOf(body), caller);
      default:
        return undefined;
    }
  }

  /** Role-filtered catalog. Exposed so a transport can answer a cheap capability probe. */
  list(caller: McpCaller): readonly ToolListEntry[] {
    const flat = this.tools.list(caller);
    const meta = this.metaFor(caller);
    if (meta === undefined) return flat;
    // Constant: the meta tools plus whatever the app left ungrouped (`docs`, `whoami`).
    const entries = MetaSurface.entriesFor(
      meta.surfaceFor(caller) === 'meta' ? 'meta' : 'meta-split',
    );
    return [...flat.filter((tool) => !meta.isGrouped(tool.name)), ...entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  /**
   * The meta catalog THIS caller would read from `list_resources`, as data — `undefined` for a caller
   * served the flat surface. For a test or a tool asserting on the catalog: the wire form is text.
   */
  catalog(caller: McpCaller): readonly MetaResource[] | undefined {
    return this.metaFor(caller)?.listResources(caller);
  }

  /** The meta surface when THIS caller is served it, else `undefined`. */
  private metaFor(caller: McpCaller): MetaSurface | undefined {
    const meta = this.meta;
    return meta !== undefined && meta.surfaceFor(caller) !== 'flat' ? meta : undefined;
  }

  /** Rate-limit class of a body without executing it — see `classifyBody`. */
  classify(body: unknown): McpVerbClass {
    return classifyBody(body, this.meta, this.tools);
  }

  private async toolsCall(req: JsonRpcRequest, caller: McpCaller): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    const params = paramsOf(req);
    if (params === null) return errorResponse(id, INVALID_PARAMS, 'tools/call requires params');
    const name = params['name'];
    if (typeof name !== 'string') {
      return errorResponse(id, INVALID_PARAMS, 'tools/call params.name must be a string');
    }

    // THE per-call gate. A tenant is stated per CALL, never per connection: evict the arg before
    // anything validates or resolves the rest, settle the app's membership answer, and dispatch
    // with a rebuilt caller — so every layer below (meta, resolve, schema, policy, the tool) sees
    // an actor that already IS the tenant's, and no tool's input schema ever models tenancy.
    // Without the option nothing moves: a single-tenant app keeps every previous byte.
    if (this.tenant === undefined) {
      return this.answerToolCall(id, name, params['arguments'], caller);
    }
    const evicted = stripTenantArgs(
      params['arguments'] === undefined
        ? undefined
        : (params['arguments'] as Readonly<Record<string, unknown>>),
      this.tenant,
    );
    if (typeof evicted.value !== 'string' || evicted.value === '') {
      return this.tenantRefused(id, name, caller);
    }
    const membership = await this.tenant.resolve(caller.actor, evicted.value);
    if (membership === undefined) {
      // Not a member = OUTCOME 1, the hidden-tool answer, bit for bit — a separate "unknown
      // tenant" error would let anyone enumerate every org this app hosts.
      return this.answerToolCall(
        id,
        name,
        { ...evicted.rest, [this.tenant.arg]: evicted.value },
        caller,
        true,
      );
    }
    const tenantCaller: McpCaller = {
      ...caller,
      actor: buildTenantActor(caller.actor, membership),
      tenant: this.tenant,
    };
    return this.answerToolCall(id, name, evicted.rest, tenantCaller);
  }

  /** The tools/call answer for an already-settled caller; also what the non-member path takes. */
  private async answerToolCall(
    id: JsonRpcId,
    name: string,
    rawArgs: unknown,
    caller: McpCaller,
    notFound = false,
  ): Promise<JsonRpcResponse> {
    if (notFound) return this.notFound(id, name, caller, TOOL_UNKNOWN_FIX);
    const meta = this.metaFor(caller);
    if (meta !== undefined) {
      const answered = await metaCall(
        {
          tools: this.tools,
          audit: this.audit,
          dispatch: (at, tool, resolved, who) => this.dispatch(at, tool, resolved, who),
          notFound: (at, tool, who, fix) => this.notFound(at, tool, who, fix),
          refuse: (at, tool, error, who) =>
            thrownResponse(at, tool, error, who, this.voice.errorAudience, this.audit),
        },
        meta,
        { id, name, rawArgs, caller },
      );
      if (answered !== undefined) return answered;
    }
    return this.dispatch(id, name, this.tools.resolve(name, rawArgs ?? {}, caller), caller);
  }

  /** X_MCP_TENANT_REQUIRED: the tool is visible, so naming the missing arg leaks nothing. */
  private tenantRefused(id: JsonRpcId, name: string, caller: McpCaller): JsonRpcResponse {
    const refusal = new McpTenantRequiredError({ name });
    this.audit.toolCall({
      tool: name,
      outcome: 'refused',
      caller,
      code: refusal.code,
    });
    return errorResponse(id, INVALID_REQUEST, refusal.cause, {
      code: refusal.code,
      fix: refusal.fix,
      docs: refusal.docs,
    });
  }

  /** OUTCOME 1, the one answer for absent and hidden alike. See `dispatch`. */
  private notFound(id: JsonRpcId, name: string, caller: McpCaller, fix: string): JsonRpcResponse {
    this.audit.toolCall({ tool: name, outcome: 'hidden', caller, code: 'X_MCP_TOOL_UNKNOWN' });
    return errorResponse(id, METHOD_NOT_FOUND, `tool not found: ${name} — ${fix}`);
  }

  /**
   * Resolve → run → audit, for a flat `tools/call` and for `manage_resource` alike: ONE path, so
   * the two surfaces cannot answer the same call differently.
   */
  private async dispatch(
    id: JsonRpcId,
    name: string,
    resolved: ToolResolution,
    caller: McpCaller,
  ): Promise<JsonRpcResponse> {
    const audience = this.voice.errorAudience;
    // Three outcomes, deliberately different — and every one of them audited, including the
    // one that tells the caller nothing. See `audit.ts`.
    switch (resolved.kind) {
      // OUTCOME 1. Absent AND role-hidden collapse to the same answer, with no `data` at
      // all: any extra field would be the difference a prober is looking for. The message
      // carries the one instruction that holds on both branches — read `tools/list` — and
      // nothing about whether the name exists: the same sentence for a stale name and for a
      // tool this role may never see, so the hint is not a second oracle.
      case 'not-found':
        return this.notFound(
          id,
          name,
          caller,
          this.metaFor(caller) ? META_UNKNOWN_FIX : TOOL_UNKNOWN_FIX,
        );
      // OUTCOME 2. The caller can already see this tool, so naming the missing scope leaks
      // nothing — and the fix travels with it, built by the error that owns the wording.
      case 'scope-denied': {
        const denial = new McpScopeDeniedError({ name, scope: resolved.scope });
        this.audit.toolCall({
          tool: name,
          outcome: 'scope-denied',
          caller,
          scope: resolved.scope,
          code: denial.code,
        });
        return errorResponse(id, INVALID_REQUEST, `missing scope: ${resolved.scope}`, {
          code: denial.code,
          scope: resolved.scope,
          fix: fixFor(denial, audience),
          docs: denial.docs,
        });
      }
      case 'invalid-args': {
        // The policy's actor half outranks the argument check: a caller the tool refuses whatever
        // they send gets the denial `handle` would give, never the issue list — which describes
        // the arguments of a tool they may not call.
        const refused = admitted(resolved.tool, caller);
        if (refused !== undefined)
          return thrownResponse(id, name, refused, caller, audience, this.audit);
        const invalid = invalidArgsResult(name, resolved.issues, audience);
        this.audit.toolCall({ tool: name, outcome: 'invalid-args', caller, code: invalid.code });
        return resultResponse(id, invalid.result);
      }
      case 'ok':
        break;
    }

    let result: McpToolResult;
    try {
      result = await resolved.tool.handle(resolved.args, caller);
    } catch (error) {
      return thrownResponse(id, name, error, caller, audience, this.audit);
    }

    // A tool may answer `isError` itself (admin renders its own denial). Outcome 3 unless it
    // NAMED the code it refused with, in which case the same classifier a thrown error goes
    // through decides — a tool's own argument check is not a denial a prober drove.
    this.audit.toolCall({
      tool: name,
      outcome: outcomeForResult(result),
      caller,
      ...(result.code === undefined ? {} : { code: result.code }),
    });
    // `code` is audit-only and never reaches the wire: it is already inside the rendered body.
    const payload: Record<string, unknown> = { content: result.content };
    // Through `manage_resource` too, byte for byte: the meta door answers what the flat one does,
    // and MCP allows `structuredContent` beside a tool (the dispatcher) that publishes no schema.
    if (result.structuredContent !== undefined && result.isError !== true) {
      payload['structuredContent'] = result.structuredContent;
    }
    if (result.isError === true) payload['isError'] = true;
    return resultResponse(id, payload);
  }
}

/**
 * The envelope refusals — no id to answer on, so `null` — rendered the way the scope refusal
 * already is: a `message` a client library surfaces verbatim, and `data: { code, fix, docs }`
 * built by the error class that owns the wording. Every other refusal on this surface carried its
 * instruction; these two answered a bare `-32600` and left the caller to guess.
 */
function protocolRefusal(message: string, error: McpProtocolError): JsonRpcResponse {
  return errorResponse(null, INVALID_REQUEST, message, {
    code: error.code,
    fix: error.fix,
    docs: error.docs,
  });
}
