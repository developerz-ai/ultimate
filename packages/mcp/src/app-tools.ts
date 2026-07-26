// `defineAppMcp` — one call that makes a GENERATED app's own dashboard AI-first.
//
// The framework's dev server drives the framework. This is the other half: a user's app
// exposes its own actions and queries as MCP tools so the user's agents can drive the
// user's app. Same projection, same policies, same registry — an app gets a real MCP server
// for the price of `mcp: { expose: true }` on the primitives it already wrote.
//
// Deliberately one function: an app author should never have to know that `ToolRegistry`,
// `frameworkResources` and `mcpHttpRoute` exist.

import type { ProjectablePrimitive } from './from-action';
import { toolsFrom } from './from-action';
import type { AnyMcpTool } from './registry';
import type { McpPrompt, McpResource } from './resources';
import type { CreateMcpServerInput } from './server';
import { createMcpServer, type McpServer } from './server';
import type { McpRouteDescriptor, ResolvedToken } from './transport-http';
import { mcpHttpRoute } from './transport-http';

export interface DefineAppMcpInput {
  /** Server identity the client shows the user. Defaults to the package name at boot. */
  readonly name?: string;
  readonly version?: string;
  /** Every action to consider. Only those with `mcp: { expose: true }` are projected. */
  readonly actions?: readonly ProjectablePrimitive[];
  /** Every query to consider. Same opt-in rule. */
  readonly queries?: readonly ProjectablePrimitive[];
  /** App-specific readable documents (a catalog export, a report). */
  readonly resources?: readonly McpResource[];
  /** Prompts the app ships for its own domain. */
  readonly prompts?: readonly McpPrompt[];
  /** Hand-written tools for things no primitive covers. Rare — prefer an action. */
  readonly tools?: readonly AnyMcpTool[];
  /** Bearer-token resolution. Omit to expose no HTTP route (stdio/embedded only). */
  resolveToken?(token: string): Promise<ResolvedToken | null> | ResolvedToken | null;
  /** Mount path. Defaults to `/mcp`. */
  readonly path?: string;
}

export interface AppMcp {
  readonly server: McpServer;
  /** The projected catalog, so a test can assert exactly what the app exposes. */
  readonly tools: readonly AnyMcpTool[];
  /** `undefined` when no `resolveToken` was given. */
  readonly route: McpRouteDescriptor | undefined;
}

/**
 * Project an app's primitives into a ready MCP server.
 *
 * ```ts
 * // apps/admin/src/mcp.ts
 * export const mcp = defineAppMcp({
 *   name: 'acme-admin',
 *   actions: [publishPost, suspendUser],
 *   queries: [liveFeed, orgUsage],
 *   resolveToken: (token) => sessions.resolveAgentToken(token),
 * });
 * ```
 */
export function defineAppMcp(input: DefineAppMcpInput): AppMcp {
  const projected = [
    ...toolsFrom(input.actions ?? []),
    ...toolsFrom(input.queries ?? []),
    ...(input.tools ?? []),
  ];
  assertUniqueNames(projected);

  const config: CreateMcpServerInput = {
    tools: projected,
    resources: input.resources ?? [],
    prompts: input.prompts ?? [],
    serverInfo: { name: input.name ?? 'ultimate-app', version: input.version ?? '0.0.0' },
  };
  const server = createMcpServer(config);

  const resolveToken = input.resolveToken;
  const route =
    resolveToken === undefined
      ? undefined
      : mcpHttpRoute({
          server,
          resolveToken,
          ...(input.path !== undefined ? { path: input.path } : {}),
        });

  return { server, tools: projected, route };
}

/**
 * A duplicate tool name is caught here rather than at first call: two primitives projecting
 * to one name means the agent silently reaches the wrong one, which is the worst failure
 * mode available. Boot-time, loud, with both offenders named.
 */
function assertUniqueNames(tools: readonly AnyMcpTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new AppMcpDuplicateError(tool.name);
    }
    seen.add(tool.name);
  }
}

class AppMcpDuplicateError extends Error {
  constructor(name: string) {
    super(
      `two primitives project to the MCP tool "${name}"; set mcp.name on one of them to disambiguate`,
    );
    this.name = 'AppMcpDuplicateError';
  }
}
