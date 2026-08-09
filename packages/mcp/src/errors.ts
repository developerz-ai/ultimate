// The X_* codes owned by @ultimat3/mcp. Each carries the exact next command, because the
// caller reading it is usually an agent with no human to ask.

import { hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const MCP_ERROR_CODES = [
  'X_MCP_TOOL_UNKNOWN',
  'X_MCP_SCOPE_DENIED',
  'X_MCP_ARGS_INVALID',
  'X_MCP_PROTOCOL',
  'X_MCP_QUERY_REJECTED',
  'X_MCP_NOT_BRANCH_DB',
  'X_MCP_TOOL_UNSAFE',
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const MCP_ERROR_TITLES: Readonly<Record<McpErrorCode, string>> = {
  X_MCP_TOOL_UNKNOWN: 'no such tool for this caller',
  X_MCP_SCOPE_DENIED: "the connection's token does not carry the tool's scope",
  X_MCP_ARGS_INVALID: 'tool arguments failed the input schema',
  X_MCP_PROTOCOL: 'the MCP handshake or auth is wrong',
  X_MCP_QUERY_REJECTED: 'db.query was not given one read-only statement',
  X_MCP_NOT_BRANCH_DB: 'db.migrate was aimed at a database that is not a branch',
  X_MCP_TOOL_UNSAFE: 'an MCP tool declares no policy',
};

// Titles must be registered for `format()` to render the contract's first line. Guarded
// because registering a code twice throws X_ERROR_CODE_DUPLICATE at import time.
for (const [code, title] of Object.entries(MCP_ERROR_TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

const docsFor = (code: McpErrorCode): string => `https://ultimate.dev/errors/${code}`;

/**
 * OUTCOME 1 of three: a tool name reached the dispatcher that no VISIBLE tool answers to —
 * the tool is absent, or it exists and this caller's role may never invoke it. One error for
 * both, on purpose. Thrown by in-process callers; over the wire the same condition is
 * `-32601` with the same message, so a role-hidden tool is indistinguishable from an absent
 * one even for a caller holding every scope in the system.
 */
export class McpToolUnknownError extends UltimateError {
  constructor(input: { name: string; visible: readonly string[] }) {
    super({
      code: 'X_MCP_TOOL_UNKNOWN',
      cause: `no MCP tool named "${input.name}" is visible to this caller (visible: ${
        input.visible.length > 0 ? input.visible.join(', ') : 'none'
      })`,
      fix: 'call tools/list to read the catalog this caller may use',
      docs: docsFor('X_MCP_TOOL_UNKNOWN'),
    });
  }
}

/**
 * OUTCOME 2 of three: the caller may SEE the tool, but the connection's token does not carry
 * its scope. Named out loud rather than hidden — the caller can legitimately fix this, and
 * hiding it would strand a well-behaved client. Scope belongs to the token, not to the
 * actor's permissions: granting it takes effect on the next connection, not this one.
 */
export class McpScopeDeniedError extends UltimateError {
  readonly scope: string;

  constructor(input: { name: string; scope: string }) {
    super({
      code: 'X_MCP_SCOPE_DENIED',
      cause: `tool "${input.name}" requires scope "${input.scope}", which this connection's token does not carry`,
      fix: `x token grant ${input.scope}   # then reconnect: scopes are fixed for the life of a connection`,
      docs: docsFor('X_MCP_SCOPE_DENIED'),
    });
    this.scope = input.scope;
  }
}

/** Arguments failed the tool's declared JSON Schema — the schema the agent was handed. */
export class McpArgsInvalidError extends UltimateError {
  constructor(input: { name: string; issues: readonly string[] }) {
    super({
      code: 'X_MCP_ARGS_INVALID',
      cause: `arguments for "${input.name}" are invalid: ${input.issues.join('; ')}`,
      fix: `re-read the tool's inputSchema from tools/list and resend`,
      docs: docsFor('X_MCP_ARGS_INVALID'),
    });
  }
}

/**
 * A hand-written tool reached `defineAppMcp` with no policy. Boot-time, because a server that
 * starts and then refuses every call is indistinguishable from one that is merely broken —
 * and a tool that starts and then allows every call is a second door into the data.
 */
export class McpToolUnsafeError extends UltimateError {
  constructor(input: { name: string }) {
    super({
      code: 'X_MCP_TOOL_UNSAFE',
      cause: `tool "${input.name}" declares no policy; an unguarded tool is a second door into the data`,
      fix: `add policy: '<resource>:<verb>' to the tool, reusing the permission its action uses`,
      docs: docsFor('X_MCP_TOOL_UNSAFE'),
    });
  }
}

/** A malformed envelope or an unsupported method — a client bug, not an authz outcome. */
export class McpProtocolError extends UltimateError {
  constructor(input: { cause: string; fix?: string }) {
    super({
      code: 'X_MCP_PROTOCOL',
      cause: input.cause,
      fix: input.fix ?? `send a JSON-RPC 2.0 body: { jsonrpc: '2.0', id, method, params }`,
      docs: docsFor('X_MCP_PROTOCOL'),
    });
  }
}

/**
 * LAYER 3 of `db.query`'s four defences: the statement is not one read-only statement, so it
 * never reaches the server. Separate from the migration refusal below because the two want
 * different next commands, and a code that covers both tells the agent neither.
 */
export class McpQueryRejectedError extends UltimateError {
  constructor(input: { cause: string; fix: string }) {
    super({
      code: 'X_MCP_QUERY_REJECTED',
      cause: `db.query refused: ${input.cause}`,
      fix: input.fix,
      docs: docsFor('X_MCP_QUERY_REJECTED'),
    });
  }
}

/**
 * `db.migrate` was pointed at a database that is not a branch. Enforced, not documented — the
 * dev server holds real credentials, and a migration is the one dev tool that cannot be undone
 * by reading the error afterwards.
 */
export class McpNotBranchDbError extends UltimateError {
  constructor(input: { cause: string; fix: string }) {
    super({
      code: 'X_MCP_NOT_BRANCH_DB',
      cause: `db.migrate refused: ${input.cause}`,
      fix: input.fix,
      docs: docsFor('X_MCP_NOT_BRANCH_DB'),
    });
  }
}
