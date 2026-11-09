// `runtimeTool()` — an app tool whose definition arrives at REQUEST time (`defineAppMcp({ catalog
// })`). Same projection as an authored app tool, no authz of its own: it BORROWS a declared
// permission through `@ultimat3/action`'s guards, and `can()` refuses one nobody declared.
//
// Only a value this factory built is servable (the `BUILT` brand).

import { asCallerContext, guardAction, guardActionBeforeInput } from '@ultimat3/action';
import type { Ctx, McpEffect } from '@ultimat3/core';
import { actorOf, renderCauseValue, useContext } from '@ultimat3/core';
import type { KnownPermission } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { McpCatalogUnresolvedError } from './catalog-errors';
import { McpToolUnsafeError } from './errors';
import { toolFrom } from './from-action';
import type { AnyMcpTool, McpToolAnnotations } from './registry';
import { runtimeInputSchema } from './runtime-schema';
import type { JsonSchema } from './wire';

export interface RuntimeToolArgs {
  /** Validated against `inputSchema` (the wire subset, defaults applied) — the only parse there is. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The ambient request context, `actor` set to the MCP caller — the tenant's, on a `tenant` server. */
  readonly ctx: Ctx;
}

export interface RuntimeToolDefinition {
  readonly name: string;
  /** Says what it does AND whether it costs money or sends mail. Agents read only this. */
  readonly description: string;
  /**
   * A JSON Schema in the wire subset, root `type: 'object'` — typically a row's column. `unknown`
   * because it usually is: anything outside the subset is refused, never published unenforced.
   */
  readonly inputSchema: unknown;
  /** An existing, DECLARED `resource:verb` permission. Never a rule invented for one tool. */
  readonly permission: KnownPermission;
  /**
   * The `scopes:` key this tool is gated under — required exactly when `defineAppMcp` declares
   * `scopes:`, and one of its keys (`X_MCP_CATALOG_UNRESOLVED` otherwise): a tool outside the map
   * would answer every token, which `X_MCP_SCOPE_UNCOVERED` refuses for a static one.
   */
  readonly scope?: string;
  /** Defaults to `true` (a write), as an app tool does: an unmarked tool is metered strictly. */
  readonly destructive?: boolean;
  /** `'write'` | `'delete'` — its dispatcher on a `'meta-split'` surface. */
  readonly effect?: McpEffect;
  readonly title?: string;
  readonly annotations?: McpToolAnnotations;
  run(args: RuntimeToolArgs): unknown;
}

/** What `runtimeTool()` hands back. Opaque: the catalog resolver returns it, the server serves it. */
export interface McpRuntimeTool {
  readonly name: string;
  /** The `scopes:` key it declared, read by `defineAppMcp`'s request-time scope check. */
  readonly scope: string | undefined;
}

/** MCP's tool-name alphabet. A row's name is data, so it is checked before it is a key. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** The brand: only a value built here is servable, so no hand-built tool skips the permission. */
const BUILT = new WeakMap<McpRuntimeTool, AnyMcpTool>();

export function runtimeTool(def: RuntimeToolDefinition): McpRuntimeTool {
  const name = def.name;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    throw new McpCatalogUnresolvedError({
      cause: `a runtime tool is named ${renderCauseValue(name)}, and a tool name is 1-128 of A-Z a-z 0-9 _ - .`,
    });
  }
  // At construction, as an app tool's is at boot: an unguarded tool is never servable.
  if (typeof def.permission !== 'string' || def.permission.length === 0) {
    throw new McpToolUnsafeError({ name });
  }
  const inputSchema: JsonSchema = runtimeInputSchema(name, def.inputSchema);
  const policy = can(def.permission);
  const tool = toolFrom({
    name,
    description: def.description,
    mcp: {
      expose: true,
      description: def.description,
      ...(def.title === undefined ? {} : { title: def.title }),
      ...(def.effect === undefined ? {} : { effect: def.effect }),
      ...(def.annotations === undefined ? {} : { annotations: def.annotations }),
    },
    inputJsonSchema: inputSchema,
    mutates: def.destructive ?? true,
    admit: (actor) =>
      asCallerContext(actor, () => {
        const ctx = useContext();
        guardActionBeforeInput(policy, { actor: actorOf(ctx), ctx, action: name }, 'mcp');
      }),
    run: ({ input, actor }) =>
      // The caller is the actor for the whole call, exactly as `app-tool.ts` runs one.
      asCallerContext(actor, async () => {
        const ctx = useContext();
        guardActionBeforeInput(policy, { actor: actorOf(ctx), ctx, action: name }, 'mcp');
        const args = input as Readonly<Record<string, unknown>>;
        guardAction(policy, { actor: actorOf(ctx), input: args, ctx, action: name }, 'mcp');
        return def.run({ input: args, ctx });
      }),
  });
  const handle: McpRuntimeTool = Object.freeze({ name, scope: def.scope });
  BUILT.set(handle, tool);
  return handle;
}

/** The tool `runtimeTool()` built for this value, or `undefined` for anything else. */
export function builtRuntimeTool(value: unknown): AnyMcpTool | undefined {
  return typeof value === 'object' && value !== null
    ? BUILT.get(value as McpRuntimeTool)
    : undefined;
}
