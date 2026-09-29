// A META caller's `tools/call`: the three meta tools, and the refusal of a grouped tool called by
// its flat name. Split from `server.ts` for the size ceiling only — it holds no gate of its own:
// every call it runs goes back through the server's `resolve` → `dispatch`, the flat path.

import { auditToolCall } from './audit';
import { META_UNKNOWN_FIX } from './meta-errors';
import type { MetaSurface } from './meta-surface';
import {
  DESCRIBE_RESOURCE,
  LIST_RESOURCES,
  META_TOOL_ENTRIES,
  renderCatalog,
  schemaOf,
} from './meta-surface';
import type { McpCaller, ToolRegistry, ToolResolution } from './registry';
import { jsonResult, textResult } from './registry';
import { validateArgs } from './validate-args';
import type { JsonRpcId, JsonRpcResponse } from './wire';
import { errorResponse, METHOD_NOT_FOUND, resultResponse } from './wire';

/** The server's own two steps, handed in so this file cannot grow a second path. */
export interface MetaHost {
  readonly tools: ToolRegistry;
  dispatch(
    id: JsonRpcId,
    name: string,
    resolved: ToolResolution,
    caller: McpCaller,
  ): Promise<JsonRpcResponse>;
  notFound(id: JsonRpcId, name: string, caller: McpCaller, fix: string): JsonRpcResponse;
}

export interface MetaRequest {
  readonly id: JsonRpcId;
  readonly name: string;
  readonly rawArgs: unknown;
  readonly caller: McpCaller;
}

/** `undefined` hands an ungrouped tool (`docs`, `whoami`) to the flat path. */
export async function metaCall(
  host: MetaHost,
  meta: MetaSurface,
  request: MetaRequest,
): Promise<JsonRpcResponse | undefined> {
  const { id, name, caller } = request;
  const entry = META_TOOL_ENTRIES.find((tool) => tool.name === name);
  if (entry === undefined) {
    return meta.isGrouped(name) ? host.notFound(id, name, caller, META_UNKNOWN_FIX) : undefined;
  }
  const args = validateArgs(entry.inputSchema, request.rawArgs ?? {});
  if (!args.ok) {
    return host.dispatch(id, name, { kind: 'invalid-args', name, issues: args.issues }, caller);
  }
  if (name === LIST_RESOURCES) {
    auditToolCall({ tool: name, outcome: 'ok', caller });
    return resultResponse(id, textResult(renderCatalog(meta.listResources(caller))));
  }
  if (name === DESCRIBE_RESOURCE) {
    const described = meta.describe(args.value['resources'] as readonly string[], caller);
    if (!described.ok) {
      // Absent and hidden are one answer, with no `data`, exactly as for a tool.
      auditToolCall({ tool: name, outcome: 'hidden', caller, code: 'X_MCP_TOOL_UNKNOWN' });
      return errorResponse(
        id,
        METHOD_NOT_FOUND,
        `resource not found: ${described.name} — ${META_UNKNOWN_FIX}`,
      );
    }
    auditToolCall({ tool: name, outcome: 'ok', caller });
    return resultResponse(id, jsonResult({ resources: described.resources }));
  }
  // `manage_resource`: address → the SAME resolve and dispatch a flat call takes, audited under
  // the tool it reached. Visibility first (a hidden pair is an absent pair), then the shared
  // resolver's scope → args. A list whitelist's issues REPLACE the tool schema's: both are pure
  // checks with nothing run between them, so which is evaluated first is invisible — the answer
  // names the whitelist, which is the contract `describe_resource` published.
  const resource = args.value['resource'] as string;
  const action = args.value['action'] as string;
  const tool = meta.locate(resource, action, caller);
  if (tool === undefined) return host.notFound(id, action, caller, META_UNKNOWN_FIX);
  const input = args.value['params'] ?? {};
  let resolved = host.tools.resolve(action, input, caller);
  if (resolved.kind !== 'scope-denied' && resolved.kind !== 'not-found') {
    const listed = validateArgs(schemaOf(tool), input);
    if (!listed.ok) {
      resolved = { kind: 'invalid-args', name: action, issues: listed.issues, tool };
    }
  }
  return host.dispatch(id, action, resolved, caller);
}
