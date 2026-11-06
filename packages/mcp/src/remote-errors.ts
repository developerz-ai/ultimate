// The refusals of an app consuming another server's tools: the server failed or refused
// (`X_MCP_REMOTE_REFUSED`, 502, `meta.failure` saying which way), it wants a token this app does
// not hold (`X_MCP_REMOTE_AUTH_REQUIRED`), and a tool no longer matches what was reviewed and
// locked (`X_MCP_REMOTE_TOOL_CHANGED`). Every value from the remote is untrusted, so it is rendered.

import {
  renderCauseValue,
  renderFixLiteral,
  renderFixShellArg,
  UltimateError,
} from '@ultimat3/core';

/**
 * How a call failed, apart from a tool's own `isError` (a SUCCESSFUL call reporting failure): no
 * answer reached us, an HTTP status refused it, a JSON-RPC `error` answered it, or the body was no
 * JSON-RPC answer at all. Four outcomes, told apart without parsing a cause.
 */
export type McpRemoteFailure = 'transport' | 'status' | 'rpc' | 'malformed';

export class McpRemoteRefusedError extends UltimateError {
  constructor(input: {
    readonly server: string;
    readonly url: string;
    readonly reason: string;
    readonly failure: McpRemoteFailure;
    readonly status?: number;
    /** The JSON-RPC `error.code`, for an `rpc` failure. */
    readonly rpcCode?: number;
    readonly sourceError?: unknown;
  }) {
    super({
      code: 'X_MCP_REMOTE_REFUSED',
      cause: `the remote MCP server "${input.server}" (${renderCauseValue(input.url)}) ${input.reason}`,
      fix: `curl -sS -X POST ${renderFixShellArg(input.url, '<url>')} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # then correct mcpTools({ url, auth })`,
      meta: {
        server: input.server,
        failure: input.failure,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.rpcCode === undefined ? {} : { rpcCode: input.rpcCode }),
      },
      ...(input.sourceError === undefined ? {} : { sourceError: input.sourceError }),
    });
  }
}

export class McpRemoteToolChangedError extends UltimateError {
  constructor(input: { readonly server: string; readonly changes: readonly string[] }) {
    super({
      code: 'X_MCP_REMOTE_TOOL_CHANGED',
      cause: `the remote MCP server "${input.server}" no longer matches tools.lock.json: ${input.changes.join('; ')}`,
      fix: `x mcp lock ${renderFixShellArg(input.server, '<name>')}   # after reviewing the changes above`,
      meta: { server: input.server, changes: [...input.changes] },
    });
  }
}

export class McpRemoteAuthRequiredError extends UltimateError {
  constructor(input: {
    readonly server: string;
    readonly url: string;
    /** RFC 9728's `resource_metadata` from the 401's `WWW-Authenticate`, when it named one. */
    readonly resourceMetadata?: string;
  }) {
    super({
      code: 'X_MCP_REMOTE_AUTH_REQUIRED',
      cause: `the remote MCP server "${input.server}" (${renderCauseValue(input.url)}) answered 401: no token was sent, or the one sent expired or was revoked${input.resourceMetadata === undefined ? '' : `; its authorization is described at ${renderCauseValue(input.resourceMetadata)}`}`,
      fix: `mcpOAuthClient({ clientId, redirectUri }).begin(${renderFixLiteral(input.url, "'<url>'")})   # send the person to authorizeUrl, keep the token exchange() returns, and hand it back from mcpTools({ auth })`,
      meta: {
        server: input.server,
        ...(input.resourceMetadata === undefined
          ? {}
          : { resourceMetadata: input.resourceMetadata }),
      },
    });
  }
}
