// The MCP server: JSON-RPC dispatch over a tool registry, a resource registry and a
// prompt list. Transport-independent — `handle(body, caller)` takes an already-parsed body
// and an already-resolved caller, and returns a response or `null` for a notification.
// Both transports (http, stdio) and every test drive this one function.

import type { ErrorAudience } from '@ultimat3/core';
import { fixFor } from '@ultimat3/core';
import { auditResourceRead, auditToolCall, outcomeForResult } from './audit';
import { McpProtocolError, McpScopeDeniedError, TOOL_UNKNOWN_FIX } from './errors';
import { asFrameworkError } from './framework-error';
import { metaCall } from './meta-call';
import { META_UNKNOWN_FIX } from './meta-errors';
import type { McpResourceGroups, McpSurfaceOption, MetaResource } from './meta-surface';
import { MANAGE_RESOURCE, META_TOOL_ENTRIES, META_TOOL_NAMES, MetaSurface } from './meta-surface';
import { promptListEntry, promptsGet } from './prompts-get';
import type {
  AnyMcpTool,
  McpCaller,
  McpToolResult,
  McpVerbClass,
  ToolListEntry,
  ToolResolution,
} from './registry';
import { ToolRegistry } from './registry';
import type { McpPrompt, McpResource } from './resources';
import { ResourceRegistry } from './resources';
import type { McpInstructions, McpServerVoice } from './server-voice';
import { instructionsFor, invalidArgsResult } from './server-voice';
import { admitted, thrownResponse } from './tool-thrown';
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse, ServerInfo } from './wire';
import {
  defaultServerInfo,
  errorResponse,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isJsonRpcRequest,
  isNotification,
  MCP_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  paramsOf,
  resultResponse,
} from './wire';

/**
 * Which wire one message arrived on, so a refusal can name the unit THAT transport counts in.
 * `handle` is transport-independent and stays so — this is a hint for the wording of one fix, never
 * a branch in dispatch. HTTP carries its mounted path because `mcpHttpRoute({ path })` is a knob:
 * a batch refusal that told every client to retry `POST /mcp` was wrong for an app mounted at
 * `/app-mcp`, which is how this came to be threaded rather than spelled.
 */
export type McpWire =
  | { readonly transport: 'http'; readonly path: string }
  | { readonly transport: 'stdio' };

/** The unit a transport counts one request in — or the neutral word when no wire said. */
const messageUnitOf = (wire: McpWire | undefined): string => {
  if (wire === undefined) return 'message';
  return wire.transport === 'http' ? `POST ${wire.path}` : 'line';
};

export interface CreateMcpServerInput {
  readonly tools?: readonly AnyMcpTool[];
  readonly resources?: readonly McpResource[];
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
}

/** The set of JSON-RPC methods this server answers. Kept in sync with `classify`. */
const METHODS = [
  'initialize',
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
] as const;

export function createMcpServer(input: CreateMcpServerInput = {}): McpServer {
  const tools = new ToolRegistry().registerAll(input.tools ?? []);
  const resources = new ResourceRegistry().registerAll(input.resources ?? []);
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

  constructor(
    tools: ToolRegistry,
    resources: ResourceRegistry,
    prompts: readonly McpPrompt[],
    serverInfo: ServerInfo,
    meta?: MetaSurface,
    voice: McpServerVoice = { errorAudience: 'developer' },
  ) {
    this.tools = tools;
    this.resources = resources;
    this.prompts = prompts;
    this.serverInfo = serverInfo;
    this.meta = meta;
    this.voice = voice;
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
    // through ai-maxxing's `POST /mcp` on 2026-09-07. The `message` is the same on every wire;
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

    switch (body.method) {
      case 'initialize': {
        const instructions = instructionsFor(this.voice.instructions, caller);
        return resultResponse(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: this.serverInfo,
          ...(instructions === undefined ? {} : { instructions }),
        });
      }
      case 'tools/list':
        return resultResponse(id, { tools: this.list(caller) });
      case 'tools/call':
        return this.toolsCall(body, caller);
      case 'resources/list':
        return resultResponse(id, { resources: this.resources.list(caller) });
      case 'resources/read':
        return this.resourcesRead(body, caller);
      // MCP's keep-alive: an empty result, which clients treat as "still here".
      case 'ping':
        return resultResponse(id, {});
      case 'prompts/list':
        return resultResponse(id, { prompts: this.prompts.map(promptListEntry) });
      case 'prompts/get':
        return promptsGet(this.prompts, id, paramsOf(body));
      default:
        return errorResponse(id, METHOD_NOT_FOUND, `method not found: ${body.method}`, {
          supported: METHODS,
        });
    }
  }

  /** Role-filtered catalog. Exposed so a transport can answer a cheap capability probe. */
  list(caller: McpCaller): readonly ToolListEntry[] {
    const flat = this.tools.list(caller);
    const meta = this.metaFor(caller);
    if (meta === undefined) return flat;
    // Constant: the three meta tools plus whatever the app left ungrouped (`docs`, `whoami`).
    return [...flat.filter((tool) => !meta.isGrouped(tool.name)), ...META_TOOL_ENTRIES].sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
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
    return meta !== undefined && meta.surfaceFor(caller) === 'meta' ? meta : undefined;
  }

  /**
   * Rate-limit class of a body WITHOUT executing it, and WITHOUT a caller — bucket
   * selection is metering, not authorization. All MCP traffic is one `POST /mcp`, so a
   * coarse per-route rule would charge `initialize` and every read to the write bucket and
   * throttle an agent on its handshake.
   *
   * KEEP IN SYNC with `handle`: only `tools/call` can reach a tool, so every other method
   * is protocol chatter that structurally cannot mutate.
   */
  classify(body: unknown): McpVerbClass {
    if (!isJsonRpcRequest(body) || body.method !== 'tools/call') return 'read';
    const params = paramsOf(body);
    const name = params?.['name'];
    // An unresolvable call is refused before it runs, so charging it the strict bucket
    // only costs a broken client — it never hands an unproven verb the cheap one.
    if (typeof name !== 'string') return 'write';
    if (this.meta !== undefined && name === MANAGE_RESOURCE) {
      // Billed as the tool it reaches, so the dispatcher is never a cheap door to a write.
      const args = params?.['arguments'];
      const action = isRecord(args) ? args['action'] : undefined;
      return typeof action === 'string' ? this.tools.verbClass(action) : 'write';
    }
    if (this.meta !== undefined && META_TOOL_NAMES.includes(name)) return 'read';
    return this.tools.verbClass(name);
  }

  private async toolsCall(req: JsonRpcRequest, caller: McpCaller): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    const params = paramsOf(req);
    if (params === null) return errorResponse(id, INVALID_PARAMS, 'tools/call requires params');
    const name = params['name'];
    if (typeof name !== 'string') {
      return errorResponse(id, INVALID_PARAMS, 'tools/call params.name must be a string');
    }

    const meta = this.metaFor(caller);
    if (meta !== undefined) {
      const answered = await metaCall(
        {
          tools: this.tools,
          dispatch: (at, tool, resolved, who) => this.dispatch(at, tool, resolved, who),
          notFound: (at, tool, who, fix) => this.notFound(at, tool, who, fix),
        },
        meta,
        { id, name, rawArgs: params['arguments'], caller },
      );
      if (answered !== undefined) return answered;
    }
    return this.dispatch(
      id,
      name,
      this.tools.resolve(name, params['arguments'] ?? {}, caller),
      caller,
    );
  }

  /** OUTCOME 1, the one answer for absent and hidden alike. See `dispatch`. */
  private notFound(id: JsonRpcId, name: string, caller: McpCaller, fix: string): JsonRpcResponse {
    auditToolCall({ tool: name, outcome: 'hidden', caller, code: 'X_MCP_TOOL_UNKNOWN' });
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
        auditToolCall({
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
        if (refused !== undefined) return thrownResponse(id, name, refused, caller, audience);
        const invalid = invalidArgsResult(name, resolved.issues, audience);
        auditToolCall({ tool: name, outcome: 'invalid-args', caller, code: invalid.code });
        return resultResponse(id, invalid.result);
      }
      case 'ok':
        break;
    }

    let result: McpToolResult;
    try {
      result = await resolved.tool.handle(resolved.args, caller);
    } catch (error) {
      return thrownResponse(id, name, error, caller, audience);
    }

    // A tool may answer `isError` itself (admin renders its own denial). Outcome 3 unless it
    // NAMED the code it refused with, in which case the same classifier a thrown error goes
    // through decides — a tool's own argument check is not a denial a prober drove.
    auditToolCall({
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

  /**
   * The same three-outcome shape `toolsCall` above applies, on the document surface. It took no
   * caller at all until 2026-08: every accepted token could list every URI and read every one of
   * them — the manifest, the OpenAPI document, the route table and the entity schema.
   *
   * And every outcome is AUDITED, hidden included, exactly as `toolsCall`'s are: this method
   * emitted nothing at all, so a URI walk over those four documents was invisible while the same
   * walk over tool names was one `warn` per attempt. `resources/list` stays silent, as
   * `tools/list` does — it is answered pre-filtered.
   */
  private async resourcesRead(req: JsonRpcRequest, caller: McpCaller): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    const uri = paramsOf(req)?.['uri'];
    if (typeof uri !== 'string') {
      return errorResponse(id, INVALID_PARAMS, 'resources/read params.uri must be a string');
    }

    const resolved = this.resources.resolve(uri, caller);
    switch (resolved.kind) {
      // OUTCOME 1. Absent AND hidden collapse to one answer with no `data`: this branch used to
      // return `available: [...every uri]`, so one wrong guess enumerated the whole catalog. No
      // `code` on the audit line either, because the wire carries none — the tool surface's
      // `X_MCP_TOOL_UNKNOWN` is an error class this branch has no twin for.
      case 'not-found':
        auditResourceRead({ uri, outcome: 'hidden', caller });
        return errorResponse(id, METHOD_NOT_FOUND, `resource not found: ${uri}`);
      // OUTCOME 2. The caller can already see this resource, so naming the missing scope leaks
      // nothing — and the fix travels with it, built by the error that owns the wording.
      case 'scope-denied': {
        const denial = new McpScopeDeniedError({
          name: uri,
          scope: resolved.scope,
          subject: 'resource',
        });
        auditResourceRead({
          uri,
          outcome: 'scope-denied',
          caller,
          scope: resolved.scope,
          code: denial.code,
        });
        return errorResponse(id, INVALID_REQUEST, `missing scope: ${resolved.scope}`, {
          code: denial.code,
          scope: resolved.scope,
          fix: fixFor(denial, this.voice.errorAudience),
          docs: denial.docs,
        });
      }
      case 'ok':
        break;
    }

    // The provider is an INJECTED THUNK — `frameworkResources` wires these to file reads, and
    // `Bun.file(...).text()` on a missing `x.manifest.json` throws ENOENT. Outside a try it escaped
    // `handle()` entirely: `serveStdio` rejected with the raw error, zero frames written, the
    // request unanswered and every later request on that buffer never processed. Same shape
    // `toolsCall` uses above, for the same reason.
    try {
      const contents = await this.resources.read(uri);
      if (contents === undefined) {
        // The resolver said `ok` and the registry then had nothing: a bug here, not a walk, so it
        // is `failed` in the log while the caller still gets the same not-found it would have.
        auditResourceRead({ uri, outcome: 'failed', caller });
        return errorResponse(id, METHOD_NOT_FOUND, `resource not found: ${uri}`);
      }
      auditResourceRead({ uri, outcome: 'ok', caller });
      return resultResponse(id, { contents: [contents] });
    } catch (error) {
      const framework = asFrameworkError(error);
      if (framework !== undefined) {
        auditResourceRead({ uri, outcome: 'failed', caller, code: framework.code });
        return errorResponse(id, INTERNAL_ERROR, `resource "${uri}" could not be read`, {
          code: framework.code,
          cause: framework.cause,
          fix: fixFor(framework, this.voice.errorAudience),
          ...(framework.docs === undefined ? {} : { docs: framework.docs }),
        });
      }
      // No internals: a provider's own message names a path, a query or a host the caller has no
      // business seeing, exactly as a failing tool's does.
      auditResourceRead({ uri, outcome: 'failed', caller });
      return errorResponse(id, INTERNAL_ERROR, `resource "${uri}" could not be read`);
    }
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
