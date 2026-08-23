/** MCP surface errors. Both are boot-time failures: an unsafe tool must never reach a client. */

// No `docs:` at any construction site below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { UltimateError } from '@ultimat3/core';

export class McpError extends UltimateError {}

export class ToolUnsafe extends McpError {
  constructor(tool: string) {
    super({
      code: 'X_MCP_TOOL_UNSAFE',
      cause: `tool "${tool}" declares no policy; an unauthenticated tool is a second door into the data`,
      fix: `add policy: '<name>' to the tool, reusing an existing policy — never write a new rule for MCP`,
    });
  }
}
