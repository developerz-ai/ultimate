// `defineAppMcp`'s `scopes:` map — OUTCOME 2's declaration surface.
//
// Visibility and the policy are declared ON the primitive: one is the tool's audience, the
// other is its authz rule, and both belong beside the code they guard. A SCOPE is neither.
// It is a capability of the CONNECTION — what the token was issued to do — so it is grouped
// here, once per scope, naming the tools that capability covers. That is also why
// `toolFromAction` never invents one: a projection cannot know what a token means.
//
// Without this map the second outcome is unreachable for a generated app. `ToolRegistry`
// enforces `scope`, the framework's own dev tools declare one, and until 2026-08 nothing an
// app could write ever set the field — an enforced gate no app declaration could engage.

import { McpScopeConflictError, McpScopeUnknownError } from './errors';
import type { AnyMcpTool } from './registry';

/**
 * Scope name → the tools it covers, BY TOOL NAME. A name, not an object reference: it is the
 * one identifier every tool in the catalog has, whichever way it got there — a projected
 * action or query, a key in the `tools` record, a ready `McpTool` from a programmatic surface.
 * It is also what the wire and a token grant both talk about, so `x token grant orders:write`
 * and this map name the same thing. A typo cannot survive boot — see `withScopes`.
 */
export type McpScopes = Readonly<Record<string, readonly string[]>>;

/**
 * Attach each declared scope to the tool it covers, refusing anything ambiguous at BOOT.
 *
 * Two refusals, because both silently ship an ungated tool otherwise:
 *
 *  - a name no tool in the catalog answers to (`X_MCP_SCOPE_UNKNOWN`) — a typo, or a primitive
 *    that was renamed or never listed. Skipping it leaves the tool reachable with no scope at
 *    all, which is the opposite of what the author wrote;
 *  - one tool claimed by two scopes (`X_MCP_SCOPE_CONFLICT`) — a tool carries ONE scope, so
 *    the second claim would either overwrite the first or be dropped, and which one wins would
 *    be decided by object key order.
 *
 * Runs AFTER duplicate names are refused, so a name resolves to exactly one tool.
 */
export function withScopes(
  tools: readonly AnyMcpTool[],
  scopes: McpScopes | undefined,
): readonly AnyMcpTool[] {
  if (scopes === undefined) return tools;

  const catalog = new Map(tools.map((tool) => [tool.name, tool]));
  const required = new Map<string, string>();

  for (const [scope, names] of Object.entries(scopes)) {
    for (const name of names) {
      if (!catalog.has(name)) {
        throw new McpScopeUnknownError({ scope, name, projected: [...catalog.keys()].sort() });
      }
      const claimed = required.get(name);
      if (claimed !== undefined && claimed !== scope) {
        throw new McpScopeConflictError({ name, scopes: [claimed, scope] });
      }
      // A tool that arrived with its own `scope` (a ready `McpTool` from a programmatic
      // surface) is claimed too: two sources for one gate is the same ambiguity.
      const declared = catalog.get(name)?.scope;
      if (declared !== undefined && declared !== scope) {
        throw new McpScopeConflictError({ name, scopes: [declared, scope] });
      }
      required.set(name, scope);
    }
  }

  return tools.map((tool) => {
    const scope = required.get(tool.name);
    return scope === undefined ? tool : { ...tool, scope };
  });
}
