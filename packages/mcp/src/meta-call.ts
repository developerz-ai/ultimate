// A META caller's `tools/call`: the meta tools, and the refusal of a grouped tool called by its
// flat name; the split surface's dispatchers continue in `meta-split-call.ts`. Split from
// `server.ts` for the size ceiling only — it holds no gate of its own: every call it runs goes back
// through the server's `resolve` → `dispatch`, the flat path.

import { META_UNKNOWN_FIX } from './meta-errors';
import type { MetaHost } from './meta-host';
import { resolveAddressed } from './meta-host';
import { splitCall } from './meta-split-call';
import { DESCRIBE_RESOURCE, LIST_RESOURCES, MetaSurface, renderCatalog } from './meta-surface';
import type { McpCaller } from './registry';
import { jsonResult, textResult } from './registry';
import { validateArgs } from './validate-args';
import type { JsonRpcId, JsonRpcResponse } from './wire';
import { errorResponse, METHOD_NOT_FOUND, resultResponse } from './wire';

export type { MetaHost } from './meta-host';

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
  const surface = meta.surfaceFor(caller) === 'meta-split' ? 'meta-split' : 'meta';
  const entry = MetaSurface.entriesFor(surface).find((tool) => tool.name === name);
  if (entry === undefined) {
    return meta.isGrouped(name) ? host.notFound(id, name, caller, META_UNKNOWN_FIX) : undefined;
  }
  const args = validateArgs(entry.inputSchema, request.rawArgs ?? {});
  if (!args.ok) {
    return host.dispatch(id, name, { kind: 'invalid-args', name, issues: args.issues }, caller);
  }
  if (name === LIST_RESOURCES) {
    host.audit.toolCall({ tool: name, outcome: 'ok', caller });
    return resultResponse(id, textResult(renderCatalog(meta.listResources(caller), surface)));
  }
  if (name === DESCRIBE_RESOURCE) {
    const described = meta.describe(args.value['resources'] as readonly string[], caller);
    if (!described.ok) {
      // Absent and hidden are one answer, with no `data`, exactly as for a tool.
      host.audit.toolCall({ tool: name, outcome: 'hidden', caller, code: 'X_MCP_TOOL_UNKNOWN' });
      return errorResponse(
        id,
        METHOD_NOT_FOUND,
        `resource not found: ${described.name} — ${META_UNKNOWN_FIX}`,
      );
    }
    host.audit.toolCall({ tool: name, outcome: 'ok', caller });
    return resultResponse(id, jsonResult({ resources: described.resources }));
  }
  if (surface === 'meta-split')
    return splitCall(host, meta, { id, name, caller, args: args.value });
  // `manage_resource`: address → the SAME resolve and dispatch a flat call takes, audited under
  // the tool it reached. Visibility first (a hidden pair is an absent pair), then the shared
  // resolver's scope → args (`resolveAddressed`).
  const resource = args.value['resource'] as string;
  const action = args.value['action'] as string;
  const tool = meta.locate(resource, action, caller);
  if (tool === undefined) return host.notFound(id, action, caller, META_UNKNOWN_FIX);
  return host.dispatch(
    id,
    action,
    resolveAddressed(host, tool, args.value['params'] ?? {}, caller),
    caller,
  );
}
