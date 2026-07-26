/** MCP surface errors. Both are boot-time failures: an unsafe tool must never reach a client. */

import { UltimateError } from '@ultimat3/core';

export class McpError extends UltimateError {}

export class ToolUnsafe extends McpError {
  constructor(tool: string) {
    super({
      code: 'X_MCP_TOOL_UNSAFE',
      cause: `tool "${tool}" declares no policy; an unauthenticated tool is a second door into the data`,
      fix: `add policy: '<name>' to the tool, reusing an existing policy — never write a new rule for MCP`,
      docs: 'https://ultimate.dev/errors/X_MCP_TOOL_UNSAFE',
    });
  }
}
