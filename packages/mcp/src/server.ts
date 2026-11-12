// The MCP server: JSON-RPC dispatch over a tool registry, a resource registry and a
// prompt list. Transport-independent — `handle(body, caller)` takes an already-parsed body
// and an already-resolved caller, and returns a response or `null` for a notification.
// Both transports (http, stdio) and every test drive this one function.

import type { Clock, ErrorAudience } from '@ultimat3/core';
import { fixFor } from '@ultimat3/core';
import { outcomeForResult } from './audit';
import type { McpAuditHook, McpAuditor } from './audit-hook';
import { LOG_ONLY_AUDITOR, mcpAuditor } from './audit-hook';
import { McpProtocolError, McpScopeDeniedError, TOOL_UNKNOWN_FIX } from './errors';
import { metaCall } from './meta-call';
import type { McpCatalogDetail } from './meta-catalog-render';
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
import type { CatalogRefused, CatalogView, McpCatalogSource, PerCall } from './server-catalog';
import { catalogRefusal, viewOf } from './server-catalog';
import { resourcesRead } from './server-resources';
import type { McpInstructions, McpServerVoice } from './server-voice';
import { instructionsFor, invalidArgsResult, screenCatalogDetail } from './server-voice';
import type { McpTenant } from './tenant';
import { assertTenant, LIST_TENANTS, listTenantsTool, tenantStep, withTenantArg } from './tenant';
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
   * How much of each action `list_resources` says: `'full'` (the default) or `'compact'` — names
   * and tags, the rest in `describe_resource`. Needs a surface that can be `'meta'`.
   */
  readonly catalogDetail?: McpCatalogDetail | undefined;
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
   * The per-caller catalog, resolved per request for `tools/list` and every `tools/call` and merged
   * with `tools`/`groups` (`server-catalog.ts`). `defineAppMcp({ catalog })` builds it.
   */
  readonly catalog?: McpCatalogSource | undefined;
  /** One token across tenants, the tenant named per call — see `tenant.ts`. */
  readonly tenant?: McpTenant | undefined;
}

export function mcpServer(input: McpServerInput = {}): McpServer {
  const tenant = input.tenant;
  if (tenant !== undefined) assertTenant(tenant, input.tools ?? []);
  // `list_tenants` is a boot tool like any other, so every surface lists it and nothing shadows it.
  const all = [...(input.tools ?? []), ...(tenant === undefined ? [] : [listTenantsTool(tenant)])];
  const tools = new ToolRegistry().registerAll(all);
  const resources = new ResourceRegistry().registerAll(input.resources ?? []);
  for (const source of input.resourceSources ?? []) resources.addSource(source);
  const meta = MetaSurface.build({
    surface: input.surface,
    groups: input.groups,
    tools: all,
  });
  const catalogDetail = screenCatalogDetail(input.catalogDetail, input.surface);
  return new McpServer(
    tools,
    resources,
    input.prompts ?? [],
    input.serverInfo ?? defaultServerInfo(),
    meta,
    {
      instructions: input.instructions,
      errorAudience: input.errorAudience ?? 'developer',
      catalogDetail,
    },
    input.onAudit === undefined && input.clock === undefined
      ? LOG_ONLY_AUDITOR
      : mcpAuditor({ onAudit: input.onAudit, clock: input.clock }),
    {
      catalog: input.catalog,
      tenant,
      tools: all,
      surface: input.surface,
      groups: input.groups,
    },
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
  private readonly perCall: PerCall | undefined;

  constructor(
    tools: ToolRegistry,
    resources: ResourceRegistry,
    prompts: readonly McpPrompt[],
    serverInfo: ServerInfo,
    meta?: MetaSurface,
    voice: McpServerVoice = { errorAudience: 'developer' },
    audit: McpAuditor = LOG_ONLY_AUDITOR,
    perCall?: PerCall,
  ) {
    this.perCall = perCall;
    this.tools = tools;
    this.resources = resources;
    this.prompts = prompts;
    this.serverInfo = serverInfo;
    this.meta = meta;
    this.voice = voice;
    this.audit = audit;
  }

  /** `signal` reaches the tool's `handle` — a transport that hears `notifications/cancelled` aborts it. */
  async handle(
    body: unknown,
    caller: McpCaller,
    wire?: McpWire | undefined,
    signal?: AbortSignal,
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
      ? await this.answer(id, body, caller, era, signal)
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
    signal: AbortSignal | undefined,
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
      case 'tools/list': {
        const view = await this.viewFor(caller);
        if ('error' in view) return catalogRefusal(id, view.error, this.voice.errorAudience);
        return resultResponse(id, { tools: this.listIn(view, caller) });
      }
      case 'tools/call':
        return this.toolsCall(body, caller, signal);
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

  /**
   * Role-filtered BOOT catalog, synchronously — a capability probe, the dev server. A server with a
   * `catalog` answers `tools/list` per request on top of it (`viewFor`).
   */
  list(caller: McpCaller): readonly ToolListEntry[] {
    return this.listIn({ tools: this.tools, meta: this.meta }, caller);
  }

  private listIn(view: CatalogView, caller: McpCaller): readonly ToolListEntry[] {
    const flat = view.tools.list(caller);
    const meta = metaServed(view.meta, caller);
    const arg = this.perCall?.tenant?.arg;
    const withArg = (entries: readonly ToolListEntry[]) =>
      arg === undefined ? entries : withTenantArg(entries, arg);
    if (meta === undefined) return withArg(flat);
    // Constant: the meta tools plus whatever the app left ungrouped (`docs`, `whoami`).
    const entries = MetaSurface.entriesFor(
      meta.surfaceFor(caller) === 'meta' ? 'meta' : 'meta-split',
    );
    return withArg(
      [...flat.filter((tool) => !meta.isGrouped(tool.name)), ...entries].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      ),
    );
  }

  /** The boot view, or this caller's resolved catalog merged over it — one per request. */
  private viewFor(caller: McpCaller): Promise<CatalogView | CatalogRefused> {
    return viewOf(this.perCall, { tools: this.tools, meta: this.meta }, caller);
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
    return metaServed(this.meta, caller);
  }

  /** Rate-limit class of a body without executing it — see `classifyBody`. */
  classify(body: unknown): McpVerbClass {
    return classifyBody(body, this.meta, this.tools);
  }

  private async toolsCall(
    req: JsonRpcRequest,
    caller: McpCaller,
    signal: AbortSignal | undefined,
  ): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    const params = paramsOf(req);
    if (params === null) return errorResponse(id, INVALID_PARAMS, 'tools/call requires params');
    const name = params['name'];
    if (typeof name !== 'string') {
      return errorResponse(id, INVALID_PARAMS, 'tools/call params.name must be a string');
    }

    // The tenant first: every gate after it, and the policy, sees the tenant's actor. Not a member
    // answers exactly as a hidden tool — `notFound`, the same call the dispatch below makes.
    let who = caller;
    let rawArgs: unknown = params['arguments'];
    const tenant = this.perCall?.tenant;
    if (tenant !== undefined && name !== LIST_TENANTS) {
      const step = await tenantStep(tenant, rawArgs, caller);
      if (step.kind === 'not-member') {
        return this.notFound(
          id,
          name,
          caller,
          this.metaFor(caller) ? META_UNKNOWN_FIX : TOOL_UNKNOWN_FIX,
        );
      }
      if (step.kind === 'refused') {
        return thrownResponse(id, name, step.error, caller, this.voice.errorAudience, this.audit);
      }
      who = step.caller;
      rawArgs = step.args;
    }
    const view = await this.viewFor(who);
    if ('error' in view) {
      return thrownResponse(id, name, view.error, who, this.voice.errorAudience, this.audit);
    }
    const meta = metaServed(view.meta, who);
    if (meta !== undefined) {
      const answered = await metaCall(
        {
          tools: view.tools,
          audit: this.audit,
          catalogDetail: this.voice.catalogDetail ?? 'full',
          dispatch: (at, tool, resolved, who) => this.dispatch(at, tool, resolved, who, signal),
          notFound: (at, tool, who, fix) => this.notFound(at, tool, who, fix),
          refuse: (at, tool, error, who) =>
            thrownResponse(at, tool, error, who, this.voice.errorAudience, this.audit),
        },
        meta,
        { id, name, rawArgs, caller: who },
      );
      if (answered !== undefined) return answered;
    }
    return this.dispatch(id, name, view.tools.resolve(name, rawArgs ?? {}, who), who, signal);
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
    signal?: AbortSignal,
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
      result = await resolved.tool.handle(resolved.args, caller, signal);
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

/** `meta` when this caller is served it, else `undefined` — one rule for the boot and a resolved view. */
function metaServed(meta: MetaSurface | undefined, caller: McpCaller): MetaSurface | undefined {
  return meta !== undefined && meta.surfaceFor(caller) !== 'flat' ? meta : undefined;
}
