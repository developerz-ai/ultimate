// `jobTool()`'s one load refusal, `X_MCP_JOB_TOOL_INVALID`: something it was handed cannot be the
// durable, reportable long tool it promises — not a job handle, an `inlineMs` past what a client
// waits, or a jobs driver that cannot say how a job is doing.

import { UltimateError } from '@ultimat3/core';

export class McpJobToolInvalidError extends UltimateError {
  constructor(input: { readonly reason: string }) {
    super({
      code: 'X_MCP_JOB_TOOL_INVALID',
      cause: `jobTool() ${input.reason}`,
      fix: "jobTool({ job: reindexJob, policy: 'catalog:admin', description, result: reindexStatus, inlineMs: 5_000 })   # job() handle, inlineMs 0..25000, postgres or memory jobs driver",
    });
  }
}
