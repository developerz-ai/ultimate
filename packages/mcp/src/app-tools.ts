// `defineAppMcp` — one call that makes a GENERATED app's own dashboard AI-first.
//
// The framework's dev server drives the framework. This is the other half: a user's app
// exposes its own actions and queries as MCP tools so the user's agents can drive the
// user's app. Same projection, same policies, same registry — an app gets a real MCP server
// for the price of `mcp: { expose: true }` on the primitives it already wrote.
//
// Deliberately one function: an app author should never have to know that `ToolRegistry`,
// `frameworkResources` and `mcpHttpRoute` exist.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { AnyAppToolDefinition, AppTools } from './app-tool';
import { appToolPrimitives } from './app-tool';
import { McpToolDuplicateError } from './errors';
import { exposedPrimitives } from './exposed';
import type { ProjectablePrimitive } from './from-action';
import { toolsFrom, toolsListed } from './from-action';
import type { AnyMcpTool } from './registry';
import type { McpPrompt, McpResource } from './resources';
import { toPrompts } from './resources';
import type { CreateMcpServerInput } from './server';
import { createMcpServer, type McpServer } from './server';
import type { McpRouteDescriptor, ResolvedToken } from './transport-http';
import { mcpHttpRoute } from './transport-http';

/** Schema map behind the authored `tools` record; inferred per tool, never written by hand. */
export type AppToolSchemas = Readonly<Record<string, StandardSchemaV1>>;

export interface DefineAppMcpInput<TSchemas extends AppToolSchemas = AppToolSchemas> {
  /** Server identity the client shows the user. Defaults to the package name at boot. */
  readonly name?: string;
  readonly version?: string;
  /**
   * `'exposed'` projects every registered action and query that declared
   * `mcp: { expose: true }`, and quietly passes over the rest — that list is every primitive the
   * app registered, not one anyone wrote out. Additive: `actions`/`queries` below still work,
   * and an explicitly listed primitive wins over the registry's copy of the same name.
   */
  readonly include?: 'exposed';
  /**
   * Actions to project. Naming one here IS the request to expose it, so a listed action that
   * never declared `mcp: { expose: true }` is `X_MCP_TOOL_UNDECLARED` at boot rather than a tool
   * missing from the catalog — exposure stays declared next to the policy, never in this list.
   */
  readonly actions?: readonly ProjectablePrimitive[];
  /** Queries to project. Same rule, same error. */
  readonly queries?: readonly ProjectablePrimitive[];
  /** App-specific readable documents (a catalog export, a report). */
  readonly resources?: readonly McpResource[];
  /** Prompts the app ships: a path to a versioned artifact, or the full descriptor. */
  readonly prompts?: readonly (string | McpPrompt)[];
  /**
   * Hand-written tools for things no primitive covers. Rare — prefer an action. Authored as a
   * record whose KEY is the tool name; the array of ready `McpTool`s stays accepted for
   * surfaces that build their catalog programmatically (`@ultimat3/admin` does).
   */
  readonly tools?: readonly AnyMcpTool[] | AppTools<TSchemas>;
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
 *   include: 'exposed',
 *   prompts: ['apps/web/app/posts/prompts/summarize.v3.md'],
 *   tools: {
 *     seatReport: {
 *       description: 'Seats used, remaining and the plan limit. Read-only.',
 *       input: t.object({}),
 *       policy: 'org:administer',
 *       async handle({ ctx }) {
 *         return seats(await ctx.orgs.byId(ctx.actor.orgId));
 *       },
 *     },
 *   },
 *   resolveToken: (token) => sessions.resolveAgentToken(token),
 * });
 * ```
 */
export function defineAppMcp<TSchemas extends AppToolSchemas>(
  input: DefineAppMcpInput<TSchemas>,
): AppMcp {
  // `toolsListed`, not `toolsFrom`: these two arrays are what the author wrote out, so an
  // undeclared entry is a mistake to report, not a primitive to pass over. ONE call over both
  // arrays, because `toolsListed` collects every offender before throwing — calling it twice
  // would throw on the first undeclared action and never look at the queries, so the author
  // fixes one list, re-boots, and meets a second `X_MCP_TOOL_UNDECLARED`.
  const listed = toolsListed([...(input.actions ?? []), ...(input.queries ?? [])]);
  // An explicitly listed primitive is a refinement of the registry's entry, not a rival to it,
  // so `include` fills the gaps rather than colliding with what the caller already spelled out.
  const included =
    input.include === 'exposed' ? notNamed(toolsFrom(exposedPrimitives()), listed) : [];
  const projected = [...listed, ...included, ...handWritten(input.tools)];
  assertUniqueNames(projected);

  const config: CreateMcpServerInput = {
    tools: projected,
    resources: input.resources ?? [],
    prompts: toPrompts(input.prompts ?? []),
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
 * The record form is normalized into primitives and then handed to the SAME `toolsFrom` that
 * projects an action — which is what makes "one projection, one authz path" true rather than
 * asserted. The array form is already a projected catalog and passes through untouched, so a
 * surface that builds its tools programmatically (`@ultimat3/admin`) keeps working verbatim.
 */
function handWritten(
  tools: readonly AnyMcpTool[] | AppTools<AppToolSchemas> | undefined,
): readonly AnyMcpTool[] {
  if (tools === undefined) return [];
  if (Array.isArray(tools)) return tools as readonly AnyMcpTool[];
  return toolsFrom(appToolPrimitives(tools as Readonly<Record<string, AnyAppToolDefinition>>));
}

function notNamed(
  tools: readonly AnyMcpTool[],
  exclude: readonly AnyMcpTool[],
): readonly AnyMcpTool[] {
  const taken = new Set(exclude.map((tool) => tool.name));
  return tools.filter((tool) => !taken.has(tool.name));
}

/**
 * A duplicate tool name is caught here rather than at first call: two primitives projecting
 * to one name means the agent silently reaches the wrong one, which is the worst failure
 * mode available. Boot-time, loud, and named.
 */
function assertUniqueNames(tools: readonly AnyMcpTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new McpToolDuplicateError({ name: tool.name });
    }
    seen.add(tool.name);
  }
}
