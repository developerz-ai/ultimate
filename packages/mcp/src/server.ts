// The MCP server: JSON-RPC dispatch over a tool registry, a resource registry and a
// prompt list. Transport-independent — `handle(body, caller)` takes an already-parsed body
// and an already-resolved caller, and returns a response or `null` for a notification.
// Both transports (http, stdio) and every test drive this one function.

import type {
  AnyMcpTool,
  McpCaller,
  McpToolResult,
  McpVerbClass,
  ToolListEntry,
} from './registry';
import { ToolRegistry } from './registry';
import type { McpPrompt, McpResource } from './resources';
import { ResourceRegistry } from './resources';
import { formatIssues } from './validate-args';
import type { JsonRpcRequest, JsonRpcResponse, ServerInfo } from './wire';
import {
  DEFAULT_SERVER_INFO,
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

export interface CreateMcpServerInput {
  readonly tools?: readonly AnyMcpTool[];
  readonly resources?: readonly McpResource[];
  readonly prompts?: readonly McpPrompt[];
  readonly serverInfo?: ServerInfo;
}

/** The set of JSON-RPC methods this server answers. Kept in sync with `classify`. */
const METHODS = [
  'initialize',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
] as const;

export function createMcpServer(input: CreateMcpServerInput = {}): McpServer {
  const tools = new ToolRegistry().registerAll(input.tools ?? []);
  const resources = new ResourceRegistry().registerAll(input.resources ?? []);
  return new McpServer(
    tools,
    resources,
    input.prompts ?? [],
    input.serverInfo ?? DEFAULT_SERVER_INFO,
  );
}

export class McpServer {
  readonly tools: ToolRegistry;
  readonly resources: ResourceRegistry;
  private readonly prompts: readonly McpPrompt[];
  private readonly serverInfo: ServerInfo;

  constructor(
    tools: ToolRegistry,
    resources: ResourceRegistry,
    prompts: readonly McpPrompt[],
    serverInfo: ServerInfo,
  ) {
    this.tools = tools;
    this.resources = resources;
    this.prompts = prompts;
    this.serverInfo = serverInfo;
  }

  async handle(body: unknown, caller: McpCaller): Promise<JsonRpcResponse | null> {
    if (!isJsonRpcRequest(body)) {
      return errorResponse(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 request envelope');
    }
    // Notifications get no answer at all; the transport replies 202 with an empty body.
    if (isNotification(body)) return null;
    const id = body.id ?? null;

    switch (body.method) {
      case 'initialize':
        return resultResponse(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: this.serverInfo,
        });
      case 'tools/list':
        return resultResponse(id, { tools: this.list(caller) });
      case 'tools/call':
        return this.toolsCall(body, caller);
      case 'resources/list':
        return resultResponse(id, { resources: this.resources.list() });
      case 'resources/read':
        return this.resourcesRead(body);
      case 'prompts/list':
        return resultResponse(id, { prompts: this.prompts });
      default:
        return errorResponse(id, METHOD_NOT_FOUND, `method not found: ${body.method}`, {
          supported: METHODS,
        });
    }
  }

  /** Role-filtered catalog. Exposed so a transport can answer a cheap capability probe. */
  list(caller: McpCaller): readonly ToolListEntry[] {
    return this.tools.list(caller);
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
    const name = paramsOf(body)?.['name'];
    // An unresolvable call is refused before it runs, so charging it the strict bucket
    // only costs a broken client — it never hands an unproven verb the cheap one.
    if (typeof name !== 'string') return 'write';
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

    const resolved = this.tools.resolve(name, params['arguments'] ?? {}, caller);
    switch (resolved.kind) {
      // Absent AND role-hidden collapse to the same answer — hidden ≠ forbidden.
      case 'not-found':
        return errorResponse(id, METHOD_NOT_FOUND, `tool not found: ${name}`);
      // The caller can see this tool, so naming its missing scope leaks nothing.
      case 'forbidden':
        return errorResponse(id, INVALID_REQUEST, `missing scope: ${resolved.scope}`, {
          code: 'X_MCP_SCOPE_MISSING',
          scope: resolved.scope,
        });
      case 'invalid-args':
        return errorResponse(id, INVALID_PARAMS, `invalid arguments for ${name}`, {
          code: 'X_MCP_ARGS_INVALID',
          issues: formatIssues(resolved.issues),
        });
      case 'ok':
        break;
    }

    let result: McpToolResult;
    try {
      result = await resolved.tool.handle(resolved.args, caller);
    } catch (error) {
      // An UltimateError thrown by a tool is an EXPECTED outcome the model can act on
      // (policy denied, migration refused), so it comes back as an `isError` result
      // carrying the code/cause/fix rather than an opaque transport failure.
      const framework = asFrameworkError(error);
      if (framework !== undefined) {
        return resultResponse(id, { content: [{ type: 'text', text: framework }], isError: true });
      }
      return errorResponse(id, INTERNAL_ERROR, `tool "${name}" failed unexpectedly`);
    }

    const payload: Record<string, unknown> = { content: result.content };
    if (result.isError === true) payload['isError'] = true;
    return resultResponse(id, payload);
  }

  private async resourcesRead(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    const uri = paramsOf(req)?.['uri'];
    if (typeof uri !== 'string') {
      return errorResponse(id, INVALID_PARAMS, 'resources/read params.uri must be a string');
    }
    const contents = await this.resources.read(uri);
    if (contents === undefined) {
      return errorResponse(id, METHOD_NOT_FOUND, `resource not found: ${uri}`, {
        available: this.resources.list().map((r) => r.uri),
      });
    }
    return resultResponse(id, { contents: [contents] });
  }
}

/**
 * Render a thrown framework error into the agent-readable three-line form, or `undefined`
 * when it is not one (a genuine bug, which becomes `-32603` with no internals leaked).
 */
function asFrameworkError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { code?: unknown; cause?: unknown; fix?: unknown };
  if (typeof e.code !== 'string' || !e.code.startsWith('X_')) return undefined;
  const cause = typeof e.cause === 'string' ? e.cause : 'unknown';
  const fix = typeof e.fix === 'string' ? e.fix : 'see docs';
  return `${e.code}\n  cause: ${cause}\n  fix:   ${fix}`;
}
