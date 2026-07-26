// The X_* codes owned by @ultimat3/mcp. Each carries the exact next command, because the
// caller reading it is usually an agent with no human to ask.

import { UltimateError } from '@ultimat3/core';

export const MCP_ERROR_CODES = [
  'X_MCP_TOOL_UNKNOWN',
  'X_MCP_SCOPE_MISSING',
  'X_MCP_ARGS_INVALID',
  'X_MCP_PROTOCOL',
  'X_MCP_READONLY_VIOLATION',
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

const docsFor = (code: McpErrorCode): string => `https://ultimate.dev/errors/${code}`;

/**
 * A tool name reached the dispatcher that no visible tool answers to. Thrown by the
 * programmatic call path (`server.call`); over the wire the same condition is
 * `-32601` so a role-hidden tool is indistinguishable from an absent one.
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

/** The caller may see the tool but its token does not carry the tool's scope. */
export class McpScopeMissingError extends UltimateError {
  constructor(input: { name: string; scope: string }) {
    super({
      code: 'X_MCP_SCOPE_MISSING',
      cause: `tool "${input.name}" requires scope "${input.scope}", which this token does not carry`,
      fix: `x token grant ${input.scope}`,
      docs: docsFor('X_MCP_SCOPE_MISSING'),
    });
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
 * A read-only surface was asked to write: `db.query` given a mutating statement, or
 * `db.migrate` pointed at a database that is not a branch. Enforced, not documented —
 * the dev server holds real credentials.
 */
export class McpReadOnlyViolationError extends UltimateError {
  constructor(input: { operation: string; cause: string; fix: string }) {
    super({
      code: 'X_MCP_READONLY_VIOLATION',
      cause: `${input.operation} refused: ${input.cause}`,
      fix: input.fix,
      docs: docsFor('X_MCP_READONLY_VIOLATION'),
    });
  }
}
