/**
 * `mcpClient()` — this app as a CLIENT of another server's MCP endpoint, over `outbound()` so the
 * deadline, the dial screen, the size cap and redaction stay the framework's one path. Both eras:
 * modern first (stateless, `_meta` version, mirrored headers); a server that refuses it is spoken
 * to in the legacy handshake (`initialize`, `Mcp-Session-Id`, re-initialized once on a 404).
 */

import { finiteCount, isJsonObject, isUltimateError, tryUseContext } from '@ultimat3/core';
import type { OutboundFetch } from '@ultimat3/core/outbound';
import { outboundResponse } from '@ultimat3/core/outbound';
import type { McpRemoteFailure } from './remote-errors';
import { McpRemoteAuthRequiredError, McpRemoteRefusedError } from './remote-errors';
import type { Listener } from './remote-listen';
import { openListener } from './remote-listen';
import {
  modernRequest,
  readNotifications,
  readRpcAnswer,
  resourceMetadataOf,
  resultText,
} from './remote-wire';
import { MCP_LEGACY_VERSIONS, MCP_MODERN_VERSIONS } from './wire';

export interface McpClientOptions {
  /** The bounded label in every cause, log line and lock entry. */
  readonly name: string;
  readonly url: string;
  /** `'public'` (default) screens every address the name answers; `'named'` dials as written. */
  readonly dial?: 'public' | 'named';
  /** One whole call, retries included. Default 30 s, clamped by the request's own deadline. */
  readonly deadlineMs?: number;
  /** Headers per call — a bearer read fresh, so a rotated token is never cached here. */
  readonly auth?: () =>
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>;
  /** The transport, for a test. Default `fetch`. */
  readonly fetch?: OutboundFetch;
  /**
   * The server said `notifications/tools/list_changed` — on a response stream, or on the `GET`
   * stream a legacy session holds open for it. `mcpTools()` re-lists and re-checks the lock here: a
   * changed list is never trusted silently.
   */
  readonly onToolsChanged?: () => void;
  /** The longest one legacy `GET` stream stays open before the next call re-opens it. Default 5 min. */
  readonly listenMs?: number;
}

/** One tool as the remote server describes it. Every string is UNTRUSTED input. */
export interface RemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The server's `readOnlyHint`, a claim — `tools.lock.json` is where a person accepts it. */
  readonly readOnlyHint: boolean;
}

export interface RemoteToolResult {
  readonly isError: boolean;
  readonly text: string;
}

export interface McpClient {
  readonly name: string;
  readonly url: string;
  listTools(options?: { readonly signal?: AbortSignal }): Promise<readonly RemoteTool[]>;
  callTool(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RemoteToolResult>;
  /** Ends the legacy `GET` stream, if one is open. Calls still work; none re-opens it. */
  close(): void;
}

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_LISTEN_MS = 300_000;
const MODERN = MCP_MODERN_VERSIONS[0];
const LEGACY = MCP_LEGACY_VERSIONS[0];

export function mcpClient(options: McpClientOptions): McpClient {
  const state: { era?: 'modern' | 'legacy'; session?: string | null; next: number } = { next: 1 };
  const listenMs = finiteCount('mcpClient', 'listenMs', options.listenMs ?? DEFAULT_LISTEN_MS, 1);
  /** The open `GET` stream; `'unsupported'` once the server answered it 405, `'closed'` after close(). */
  let listener: Listener | 'unsupported' | 'closed' | undefined;
  const refused = (
    reason: string,
    failure: McpRemoteFailure,
    status?: number,
    sourceError?: unknown,
  ) =>
    new McpRemoteRefusedError({
      server: options.name,
      url: options.url,
      reason,
      failure,
      ...(status === undefined ? {} : { status }),
      ...(sourceError === undefined ? {} : { sourceError }),
    });

  /** One POST. `undefined` body answer is a notification's 202. */
  const post = async (
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly headers: Headers;
    readonly text: string;
    readonly type: string | null;
  }> => {
    const auth = (await options.auth?.()) ?? {};
    let answer: Response;
    try {
      answer = await outboundResponse(
        {
          url: options.url,
          vendor: `mcp:${options.name}`,
          dial: options.dial ?? 'public',
          deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...auth,
            ...headers,
          },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        },
        options.fetch === undefined ? {} : { fetch: options.fetch },
      );
    } catch (error) {
      if (!isUltimateError(error)) throw error;
      // An abort is the caller's decision, never the server's fault: it passes through.
      if (error.code === 'X_ABORTED') throw error;
      throw refused(`was not reachable (${error.code})`, 'transport', undefined, error);
    }
    // A token is wanted, or the one sent is no longer good: never an era to fall back from.
    if (answer.status === 401) {
      const metadata = resourceMetadataOf(answer.headers.get('www-authenticate'));
      throw new McpRemoteAuthRequiredError({
        server: options.name,
        url: options.url,
        ...(metadata === undefined ? {} : { resourceMetadata: metadata }),
      });
    }
    if (!answer.ok) {
      throw refused(`answered HTTP ${String(answer.status)}`, 'status', answer.status);
    }
    return {
      headers: answer.headers,
      text: await answer.text(),
      type: answer.headers.get('content-type'),
    };
  };

  const rpc = async (
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> => {
    const id = state.next++;
    let body: Record<string, unknown>;
    let headers: Record<string, string>;
    if (state.era === 'legacy') {
      body = { jsonrpc: '2.0', id, method, params };
      headers = { 'mcp-protocol-version': LEGACY };
      if (typeof state.session === 'string') headers['mcp-session-id'] = state.session;
    } else {
      ({ body, headers } = modernRequest(MODERN, id, method, params));
    }
    const answer = await post(body, headers, signal);
    heard(answer.type, answer.text);
    const message = readRpcAnswer(answer.type, answer.text, id);
    if (message === undefined) {
      throw refused(`answered ${method} with no JSON-RPC response`, 'malformed');
    }
    const error = message['error'];
    if (isJsonObject(error)) {
      const code = typeof error['code'] === 'number' ? error['code'] : 0;
      throw new McpRemoteRefusedError({
        server: options.name,
        url: options.url,
        reason: `answered ${method} with JSON-RPC error ${String(code)}`,
        failure: 'rpc',
        rpcCode: code,
        sourceError: error,
      });
    }
    if (!isJsonObject(message['result'])) {
      throw refused(`answered ${method} with no result`, 'malformed');
    }
    return message['result'];
  };

  const initialize = async (signal: AbortSignal | undefined): Promise<void> => {
    state.era = 'legacy';
    state.session = null;
    const id = state.next++;
    const answer = await post(
      {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY,
          capabilities: {},
          clientInfo: { name: 'ultimate', version: '1' },
        },
      },
      {},
      signal,
    );
    const message = readRpcAnswer(answer.type, answer.text, id);
    if (message === undefined || !isJsonObject(message['result'])) {
      throw refused(
        'refused both protocol eras (no server/discover, no initialize result)',
        'malformed',
      );
    }
    state.session = answer.headers.get('mcp-session-id');
    const notify = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const session = state.session === null ? {} : { 'mcp-session-id': state.session };
    await post(notify, { 'mcp-protocol-version': LEGACY, ...session }, signal);
  };

  /**
   * A legacy session's `GET` stream, opened once a session exists and re-opened by the next call
   * after it ends — only when someone listens for a change. A modern server is stateless: it has
   * no session to push on, so its changes ride the response streams alone.
   */
  const listen = (): void => {
    if (options.onToolsChanged === undefined || state.era !== 'legacy') return;
    if (listener !== undefined) return;
    const opened = openListener({
      name: options.name,
      url: options.url,
      dial: options.dial ?? 'public',
      listenMs,
      fetch: options.fetch,
      headers: async () => ({
        ...((await options.auth?.()) ?? {}),
        'mcp-protocol-version': LEGACY,
        ...(typeof state.session === 'string' ? { 'mcp-session-id': state.session } : {}),
      }),
      heard: (method) => {
        if (method === 'notifications/tools/list_changed') options.onToolsChanged?.();
      },
    });
    listener = opened;
    void opened.ended.then((end) => {
      if (listener !== opened) return;
      listener = end === 'unsupported' ? 'unsupported' : undefined;
    });
  };

  /** A notification riding a response stream: only a changed tool list is acted on. */
  const heard = (type: string | null, text: string): void => {
    if (readNotifications(type, text).includes('notifications/tools/list_changed')) {
      options.onToolsChanged?.();
    }
  };

  /** The era, decided once per client: modern unless the server refuses it. */
  const call = async (
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> => {
    listen();
    if (state.era === undefined) {
      try {
        const result = await rpc(method, params, signal);
        state.era = 'modern';
        return result;
      } catch (error) {
        if (!(error instanceof McpRemoteRefusedError) || !eraRefusal(error)) throw error;
        await initialize(signal);
        listen();
      }
    }
    try {
      return await rpc(method, params, signal);
    } catch (error) {
      // A legacy session the server forgot (404) is re-opened ONCE, as the transport spec says.
      if (!(error instanceof McpRemoteRefusedError) || error.meta?.['status'] !== 404) throw error;
      if (state.era !== 'legacy') throw error;
      // The session is gone, and so is any stream that hung off it: the new one gets its own.
      if (typeof listener === 'object') {
        listener.close();
        listener = undefined;
      }
      await initialize(signal);
      listen();
      return rpc(method, params, signal);
    }
  };

  return {
    name: options.name,
    url: options.url,
    async listTools(listOptions = {}) {
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      // Paged; bounded so a server that loops its cursor cannot hold the boot forever.
      for (let page = 0; page < 50; page += 1) {
        const result = await call(
          'tools/list',
          cursor === undefined ? {} : { cursor },
          listOptions.signal,
        );
        for (const tool of Array.isArray(result['tools']) ? result['tools'] : []) {
          if (isJsonObject(tool) && typeof tool['name'] === 'string') tools.push(remoteTool(tool));
        }
        cursor = typeof result['nextCursor'] === 'string' ? result['nextCursor'] : undefined;
        if (cursor === undefined) break;
      }
      return tools;
    },
    close() {
      if (typeof listener === 'object') listener.close();
      listener = 'closed';
    },
    async callTool(tool, args, callOptions = {}) {
      const { signal } = callOptions;
      try {
        const result = await call('tools/call', { name: tool, arguments: args }, signal);
        return { isError: result['isError'] === true, text: resultText(result) };
      } finally {
        if (signal?.aborted === true && state.era === 'legacy') cancelled(tool);
      }
    },
  };

  /** Legacy servers hear a cancellation as a notification; best effort, and said so in the log. */
  function cancelled(tool: string): void {
    const headers: Record<string, string> = { 'mcp-protocol-version': LEGACY };
    if (typeof state.session === 'string') headers['mcp-session-id'] = state.session;
    const notice = {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: state.next - 1 },
    };
    post(notice, headers, undefined).catch((error: unknown) => {
      tryUseContext()?.logger.warn('mcp.remote.cancel_unsent', {
        server: options.name,
        tool,
        code: isUltimateError(error) ? error.code : 'unknown',
      });
    });
  }
}

function remoteTool(raw: Record<string, unknown>): RemoteTool {
  const annotations = isJsonObject(raw['annotations']) ? raw['annotations'] : {};
  return {
    name: String(raw['name']),
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    inputSchema: isJsonObject(raw['inputSchema']) ? raw['inputSchema'] : { type: 'object' },
    readOnlyHint: annotations['readOnlyHint'] === true,
  };
}

/**
 * Whether a first modern request was refused for its ERA — a 4xx a legacy server gives an unknown
 * shape, a body that is no answer, or the codes for an unknown version, method or request — rather
 * than for its content. Only then is the legacy handshake tried; a modern server's own failure
 * (`-32603`, a 503) is that failure.
 */
const ERA_RPC_CODES: ReadonlySet<number> = new Set([-32022, -32601, -32600, -32602]);

function eraRefusal(error: McpRemoteRefusedError): boolean {
  const failure = error.meta?.['failure'];
  const status = error.meta?.['status'];
  const code = error.meta?.['rpcCode'];
  if (failure === 'malformed') return true;
  if (failure === 'status') return typeof status === 'number' && status >= 400 && status < 500;
  return failure === 'rpc' && typeof code === 'number' && ERA_RPC_CODES.has(code);
}
