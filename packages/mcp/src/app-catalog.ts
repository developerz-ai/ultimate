// `defineAppMcp({ catalog })` — the app's per-caller resolver, checked into what the server serves.
//
// Only `runtimeTool()` values pass (so every runtime tool borrows a declared permission); each one's
// `scope` is held to the boot `scopes:` map exactly as `withScopes` holds a static tool; and each is
// wrapped by the registered confirmation gate a static tool gets. Per request, never cached.

import { renderCauseValue } from '@ultimat3/core';
import { McpCatalogUnresolvedError } from './catalog-errors';
import { withConfirmations } from './confirmation-gate';
import type { McpResourceGroups } from './meta-surface';
import type { AnyMcpTool, McpCaller } from './registry';
import type { McpRuntimeTool } from './runtime-tool';
import { builtRuntimeTool } from './runtime-tool';
import type { McpScopes } from './scopes';
import type { McpCatalogSource, McpResolvedCatalog } from './server-catalog';

/** What the app's resolver answers for one caller. */
export interface McpRuntimeCatalog {
  /** Built by `runtimeTool()` — nothing else is servable. */
  readonly tools: readonly McpRuntimeTool[];
  /** Resources for `list_resources` on a meta surface, beside `groups:` — new names only. */
  readonly groups?: McpResourceGroups;
}

/**
 * The tools THIS caller may call beyond the static ones, asked for every `tools/list` and every
 * `tools/call`. It already filters by caller, so a runtime tool takes no `visibleTo`. On a `tenant`
 * server, `tools/list` asks it for the person and `tools/call` for the call's tenant actor.
 */
export type McpCatalog = (caller: McpCaller) => Promise<McpRuntimeCatalog> | McpRuntimeCatalog;

export function appCatalogSource(
  catalog: McpCatalog,
  scopes: McpScopes | undefined,
): McpCatalogSource {
  return async (caller) => checked(await catalog(caller), scopes);
}

function checked(resolved: McpRuntimeCatalog, scopes: McpScopes | undefined): McpResolvedCatalog {
  if (typeof resolved !== 'object' || resolved === null || !Array.isArray(resolved.tools)) {
    throw new McpCatalogUnresolvedError({
      cause: 'the catalog resolver answered something other than { tools: runtimeTool()[] }',
    });
  }
  const tools = resolved.tools.map((entry, index): AnyMcpTool => {
    const tool = builtRuntimeTool(entry);
    if (tool === undefined) {
      throw new McpCatalogUnresolvedError({
        cause: `catalog entry ${index} was not built by runtimeTool(), so it carries no declared permission`,
      });
    }
    return scoped(tool, entry.scope, scopes);
  });
  return {
    tools: withConfirmations(tools, undefined),
    ...(resolved.groups === undefined ? {} : { groups: resolved.groups }),
  };
}

/** Outcome 2 for a runtime tool: a key of the boot `scopes:` map, required exactly when there is one. */
function scoped(
  tool: AnyMcpTool,
  scope: string | undefined,
  scopes: McpScopes | undefined,
): AnyMcpTool {
  const name = renderCauseValue(tool.name);
  if (scopes === undefined) {
    if (scope === undefined) return tool;
    throw new McpCatalogUnresolvedError({
      cause: `runtime tool ${name} names scope ${renderCauseValue(scope)}, and defineAppMcp declares no scopes:`,
    });
  }
  if (scope === undefined) {
    throw new McpCatalogUnresolvedError({
      cause: `runtime tool ${name} names no scope, and defineAppMcp declares scopes: — it would answer every token`,
    });
  }
  if (!Object.hasOwn(scopes, scope)) {
    throw new McpCatalogUnresolvedError({
      cause: `runtime tool ${name} names scope ${renderCauseValue(scope)}, which scopes: does not declare`,
    });
  }
  return { ...tool, scope };
}
