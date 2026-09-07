// The MCP server: JSON-RPC dispatch over a tool registry, a resource registry and a
// prompt list. Transport-independent — `handle(body, caller)` takes an already-parsed body
// and an already-resolved caller, and returns a response or `null` for a notification.
// Both transports (http, stdio) and every test drive this one function.

import { FRAMEWORK_CODE, singleLine, stringField } from '@ultimat3/core';
import { formatIssues } from '@ultimat3/schema';
import { auditResourceRead, auditToolCall, outcomeForCode, outcomeForResult } from './audit';
import { McpProtocolError, McpScopeDeniedError, TOOL_UNKNOWN_FIX } from './errors';
import type { AnyMcpTool, McpCaller, McpToolResult, McpVerbClass, ToolListEntry } from './registry';
import { ToolRegistry } from './registry';
import type { McpPrompt, McpResource } from './resources';
import { ResourceRegistry } from './resources';
import type { JsonRpcRequest, JsonRpcResponse, ServerInfo } from './wire';
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
    input.serverInfo ?? defaultServerInfo(),
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
        return resultResponse(id, { resources: this.resources.list(caller) });
      case 'resources/read':
        return this.resourcesRead(body, caller);
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

    // Three outcomes, deliberately different — and every one of them audited, including the
    // one that tells the caller nothing. See `audit.ts`.
    const resolved = this.tools.resolve(name, params['arguments'] ?? {}, caller);
    switch (resolved.kind) {
      // OUTCOME 1. Absent AND role-hidden collapse to the same answer, with no `data` at
      // all: any extra field would be the difference a prober is looking for. The message
      // carries the one instruction that holds on both branches — read `tools/list` — and
      // nothing about whether the name exists: the same sentence for a stale name and for a
      // tool this role may never see, so the hint is not a second oracle.
      case 'not-found':
        auditToolCall({ tool: name, outcome: 'hidden', caller, code: 'X_MCP_TOOL_UNKNOWN' });
        return errorResponse(id, METHOD_NOT_FOUND, `tool not found: ${name} — ${TOOL_UNKNOWN_FIX}`);
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
          fix: denial.fix,
          docs: denial.docs,
        });
      }
      case 'invalid-args':
        auditToolCall({ tool: name, outcome: 'invalid-args', caller, code: 'X_MCP_ARGS_INVALID' });
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
      // OUTCOME 3 arrives here: the tool ran its policy through `guard()` and the policy
      // said no. An UltimateError is an EXPECTED outcome the model can act on, so it comes
      // back as an `isError` result carrying code/cause/fix — the same three lines an HTTP
      // caller gets for the same call — rather than an opaque transport failure.
      const framework = asFrameworkError(error);
      if (framework !== undefined) {
        auditToolCall({
          tool: name,
          outcome: outcomeForCode(framework.code),
          caller,
          code: framework.code,
        });
        return resultResponse(id, {
          content: [{ type: 'text', text: renderFrameworkError(framework) }],
          isError: true,
        });
      }
      auditToolCall({ tool: name, outcome: 'failed', caller });
      return errorResponse(id, INTERNAL_ERROR, `tool "${name}" failed unexpectedly`);
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
          fix: denial.fix,
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
          fix: framework.fix,
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

interface FrameworkError {
  readonly code: string;
  /** `''` for a foreign thrown object that carries no title. See `renderFrameworkError`. */
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
}

/**
 * Read a thrown framework error, or `undefined` when it is not one (a genuine bug, which
 * becomes `-32603` with no internals leaked). Structural rather than `instanceof`: the
 * transport must stay independent of which package threw.
 */
function asFrameworkError(error: unknown): FrameworkError | undefined {
  // `stringField` from `@ultimat3/core`, never `typeof e.code === 'string'`: the value is whatever
  // an app's handler, its driver or its SDK threw, so each read is a getter call or a `Proxy`
  // trap. This runs inside the catch block that owes the caller an answer, and a probe that
  // raises here leaves the JSON-RPC request with no response at all — not even the `-32603` the
  // header promises for a genuine bug.
  const code = stringField(error, 'code');
  // `FRAMEWORK_CODE`, never `startsWith('X_')`: the substituted `fix:` below interpolates this
  // value into a COMMAND an agent is told to run, and `X_$(id)` passes a prefix test. A code is
  // `X_SCREAMING_SNAKE` and nothing else, so a value that is not one is not a framework error —
  // it takes the `-32603` branch, which leaks nothing of the throw.
  if (code === undefined || !FRAMEWORK_CODE.test(code)) return undefined;
  return {
    code,
    title: stringField(error, 'title') ?? '',
    cause: stringField(error, 'cause') ?? 'unknown',
    // A substituted fix is still a fix an agent will act on, so it has to be runnable. `see docs`
    // named no docs and no command; `code` is already narrowed to an `X_` string by the guard
    // above, so the substitute is the one command that explains exactly this code.
    fix: stringField(error, 'fix') ?? `x errors explain ${code}`,
  };
}

/**
 * The agent-readable form, BYTE-IDENTICAL to `UltimateError.format()` — one denial reads the
 * same over MCP as it does in the terminal, so an agent that learned the shape from `x` does
 * not have to learn a second one here. Dropping the title would be a second rendering of the
 * same contract, and the two would drift.
 *
 * The bare-`code` head is the fallback for a foreign thrown object that carries `code`/`cause`
 * but no title; a real `UltimateError` always has one.
 */
function renderFrameworkError(error: FrameworkError): string {
  const head =
    error.title === ''
      ? singleLine(error.code)
      : `${singleLine(error.code)}: ${singleLine(error.title)}`;
  return `${head}\n  cause: ${singleLine(error.cause)}\n  fix:   ${singleLine(error.fix)}`;
}
