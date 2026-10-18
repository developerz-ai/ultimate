// The server's half of a meta dispatch, handed to `meta-call.ts` and `meta-split-call.ts` so neither
// can grow a second path: its `dispatch` IS the flat `tools/call`'s resolve → run → audit.

import type { McpAuditor } from './audit-hook';
import { schemaOf } from './meta-surface';
import type { AnyMcpTool, McpCaller, ToolRegistry, ToolResolution } from './registry';
import { validateArgs } from './validate-args';
import type { JsonRpcId, JsonRpcResponse } from './wire';

/** The server's own two steps, handed in so this file cannot grow a second path. */
export interface MetaHost {
  readonly tools: ToolRegistry;
  readonly audit: McpAuditor;
  dispatch(
    id: JsonRpcId,
    name: string,
    resolved: ToolResolution,
    caller: McpCaller,
  ): Promise<JsonRpcResponse>;
  notFound(id: JsonRpcId, name: string, caller: McpCaller, fix: string): JsonRpcResponse;
  /** A coded refusal rendered and audited exactly as a thrown one — `tool-thrown.ts`. */
  refuse(id: JsonRpcId, name: string, error: unknown, caller: McpCaller): JsonRpcResponse;
}

/**
 * The shared resolver's scope → args for a tool a dispatcher located, with a list whitelist's
 * issues REPLACING the tool schema's: both are pure checks with nothing run between them, so which
 * is evaluated first is invisible — the answer names the whitelist, which is the contract
 * `describe_resource` published.
 */
export function resolveAddressed(
  host: MetaHost,
  tool: AnyMcpTool,
  input: unknown,
  caller: McpCaller,
): ToolResolution {
  const resolved = host.tools.resolve(tool.name, input, caller);
  if (resolved.kind === 'scope-denied' || resolved.kind === 'not-found') return resolved;
  const listed = validateArgs(schemaOf(tool), input);
  return listed.ok
    ? resolved
    : { kind: 'invalid-args', name: tool.name, issues: listed.issues, tool };
}
