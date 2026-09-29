// What a `tools/call` answers when the tool threw — or its `admit` refused the caller before the
// arguments were read. One renderer for both, so a policy denial reads the same whichever gate
// raised it. Split from `server.ts` for the file ceiling; the server is its only caller.

import type { ErrorAudience } from '@ultimat3/core';
import { auditToolCall, outcomeForCode } from './audit';
import { asFrameworkError, renderFrameworkError } from './framework-error';
import type { AnyMcpTool, McpCaller } from './registry';
import type { JsonRpcId, JsonRpcResponse } from './wire';
import { errorResponse, INTERNAL_ERROR, resultResponse } from './wire';

/**
 * OUTCOME 3 arrives here: the tool ran its policy through `guard()` and the policy said no. An
 * UltimateError is an EXPECTED outcome the model can act on, so it comes back as an `isError`
 * result carrying code/cause/fix — the same three lines an HTTP caller gets for the same call —
 * rather than an opaque transport failure.
 */
export function thrownResponse(
  id: JsonRpcId,
  name: string,
  error: unknown,
  caller: McpCaller,
  audience: ErrorAudience,
): JsonRpcResponse {
  const framework = asFrameworkError(error);
  if (framework !== undefined) {
    auditToolCall({
      tool: name,
      outcome: outcomeForCode(framework.code),
      caller,
      code: framework.code,
    });
    return resultResponse(id, {
      content: [{ type: 'text', text: renderFrameworkError(framework, audience) }],
      isError: true,
    });
  }
  auditToolCall({ tool: name, outcome: 'failed', caller });
  return errorResponse(id, INTERNAL_ERROR, `tool "${name}" failed unexpectedly`);
}

/** What the tool's `admit` threw for this caller, or `undefined` when it let them through. */
export function admitted(tool: AnyMcpTool | undefined, caller: McpCaller): unknown {
  if (tool?.admit === undefined) return undefined;
  try {
    tool.admit(caller);
    return undefined;
  } catch (error) {
    return error;
  }
}
