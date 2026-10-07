// The free-tool projection: an `action` (or `query`) with `mcp.expose` becomes an MCP tool
// at zero authorization cost.
//
// The whole claim rests on one line in `handle` below: the tool calls `primitive.run(...)`, and
// `projectable.ts` builds that `run` out of `invoke(target, …, { surface: 'mcp' })` — the SAME
// function `toRoute`'s handler calls for an HTTP request, differing only in the surface it
// declares. (An action has NO `.run` member — it is `as`/`tool`/`openapi`/`job`/`contract` and
// the callable itself; this comment named one until 2026-08. `run` is `ProjectablePrimitive`'s,
// the seam, and a query's half of it is `sourceFor`.) Policy evaluation lives inside `invoke`, so
// there is nothing here to keep in sync and no second authz system to drift. This
// projection therefore INVENTS no `scope`: a scope is a capability of the connection's
// token, which a projection cannot know anything about. An app that wants one names the
// tool in `defineAppMcp`'s `scopes:` map (see `scopes.ts`) — declared once, next to the
// other tools that same token capability covers, never guessed from the action.
//
// `toWireSchema` from `@ultimat3/schema`, reached through `projectable.ts`, owns the schema half
// of what THIS server publishes; this file owns the execution half. It is the ONE tool projection:
// `@ultimat3/action`'s `.tool()` and `@ultimat3/query`'s were a second, built a tier below, and
// disagreed with what `tools/list` served — deleted in 25.0.0 (O-tool), because tier 3 cannot
// import this one to return it. `cross-surface.test.ts` pins `toolFrom` to the served entry.

import type { Actor } from '@ultimat3/core';
import { isMcpExposed } from '@ultimat3/core';
import { McpToolUndeclaredError } from './errors';
import type { McpListParams } from './list-params';
import type { ListedPrimitive } from './projectable';
import { asProjectable } from './projectable';
import type {
  AnyMcpTool,
  McpCaller,
  McpRole,
  McpToolAnnotations,
  McpToolResult,
  ToolArgs,
} from './registry';
import { jsonResult, structuredResult } from './registry';
import type { JsonSchema } from './wire';
import { NO_ARGS } from './wire';

/**
 * MCP exposure as declared on an action/query (`mcp: { expose: true, description }`).
 * `visibleTo` restricts which roles may enumerate the tool; it is a catalog concern, not
 * an authz one — the policy still decides.
 */
export interface McpExposure {
  readonly expose?: boolean;
  /**
   * Contract text, not UI text: the same string is the OpenAPI operation `summary`, and
   * `buildOpenApi`'s bytes are what `x verify` diffs. Routing it through the ambient,
   * request-scoped `t()` would make that artifact locale-dependent — see
   * `ActionMcp.description` in @ultimat3/action.
   */
  readonly description?: string;
  readonly visibleTo?: readonly McpRole[];
  /** Display name for a client's UI. Contract text, like `description`. Absent: none published. */
  readonly title?: string;
  /**
   * Overrides of the derived hints, key by key — see `deriveAnnotations`. The one declaration an
   * app writes for a write that destroys nothing: `annotations: { destructiveHint: false }`.
   */
  readonly annotations?: McpToolAnnotations;
  /** A list query's whitelist, carried to the tool for the meta surface. See `McpListParams`. */
  readonly listParams?: McpListParams;
}

/**
 * The surface this projection needs from a primitive. Structurally satisfied by `Action`
 * and by `query`'s runnable handle from @ultimat3/action / @ultimat3/query — restated here
 * (rather than imported as a generic) so the projection is testable with a fake and does
 * not bind to either package's type parameters.
 */
export interface ProjectablePrimitive {
  readonly name: string;
  readonly description?: string;
  readonly mcp?: McpExposure;
  /** JSON Schema of the input, narrowed to the wire subset by `toWireSchema`. */
  readonly inputJsonSchema?: JsonSchema;
  /** True for a mutation. Drives the rate-limit bucket; queries set it false. */
  readonly mutates?: boolean;
  /** The action honours an idempotency key — a repeat is answered, not re-run. */
  readonly idempotent?: boolean;
  /**
   * The `outputSchema` to publish, already narrowed (`toWireOutputSchema`) with an OBJECT root.
   * Absent: no `outputSchema`, no `structuredContent` — only the text block.
   */
  readonly outputJsonSchema?: JsonSchema;
  /**
   * The key an ARRAY answer is published under in `structuredContent` — `rows` for a query, whose
   * answer is a list and whose `outputSchema` is `{ rows: [<row>] }`. Absent: the answer IS the object.
   */
  readonly outputWrap?: string;
  /** The one server-authoritative entry point. Runs policy, then the handler. */
  run(args: { input: unknown; actor: Actor }): Promise<unknown>;
  /**
   * The policy's actor half, alone: throws the denial `run` would raise for this actor whatever
   * the input, returns otherwise. Becomes the tool's `admit`. Absent: no before-args gate.
   */
  admit?(actor: Actor): void;
}

/**
 * True when the primitive opted into MCP — `@ultimat3/core`'s `isMcpExposed`, the one predicate
 * the manifest fact and the OpenAPI hint ask too. Private: the exported wrapper was a second name
 * for core's function (plan 101, M3), and an app asks core's directly.
 */
function exposed(primitive: ProjectablePrimitive): boolean {
  return isMcpExposed(primitive.mcp);
}

/**
 * Project one primitive — an `action()`, a `query()`, or a hand-built `ProjectablePrimitive` —
 * into the tool this server serves. THE projection: `toolListEntry(toolFrom(publishPost))`
 * is, field for field, the entry `tools/list` answers for it. Does not re-check exposure: the two
 * list projections below decide what an un-exposed primitive means — skip it, or refuse it. A
 * real action or query that was never registered throws `X_ACTION_UNREGISTERED` /
 * `X_QUERY_UNREGISTERED`, rather than projecting a tool called `''`.
 */
export function toolFrom(listed: ListedPrimitive): AnyMcpTool {
  const primitive = asProjectable(listed);
  // The primitive's own name and nothing else: `McpExposure.name` was a second naming field no
  // declaration could set, deleted in 25.0.0 (plan 101, M4).
  const name = primitive.name;
  const description =
    primitive.mcp?.description ?? primitive.description ?? `Run the "${primitive.name}" action.`;
  const mutates = primitive.mutates ?? true;
  const visibleTo = primitive.mcp?.visibleTo;
  const listParams = primitive.mcp?.listParams;
  const title = primitive.mcp?.title;
  const outputSchema = primitive.outputJsonSchema;
  const wrap = primitive.outputWrap;

  return {
    name,
    ...(title !== undefined ? { title } : {}),
    description,
    inputSchema: primitive.inputJsonSchema ?? NO_ARGS,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    annotations: deriveAnnotations(primitive),
    destructive: mutates,
    ...(visibleTo !== undefined ? { visibleTo } : {}),
    ...(listParams !== undefined ? { listParams } : {}),
    ...(primitive.admit === undefined
      ? {}
      : { admit: (caller: McpCaller) => primitive.admit?.(caller.actor) }),
    // No `scope` from here: see the header. `defineAppMcp`'s `scopes:` map may add one.
    async handle(args: ToolArgs, caller: McpCaller): Promise<McpToolResult> {
      // ONE authz system, TWO surfaces. This `run` IS `invoke`; the HTTP route reaches the
      // same `invoke` with an actor of kind 'user', MCP arrives with kind 'agent'. Same
      // policy, same decision.
      const output = await primitive.run({ input: args, actor: caller.actor });
      return outputSchema === undefined ? jsonResult(output) : structuredResult(output, wrap);
    },
  };
}

/**
 * The MCP hints a primitive's KIND already answers, with the author's `mcp.annotations` laid over
 * them key by key:
 *
 * | primitive | readOnlyHint | destructiveHint | idempotentHint |
 * |---|---|---|---|
 * | query (`mutates: false`) | `true` | — | — |
 * | action | `false` | `true` | `idempotent: true` on the action |
 *
 * `destructiveHint: true` for every action is the spec's own default made explicit, and the only
 * safe one: the framework cannot tell an insert from a delete. `openWorldHint` is never derived —
 * only the author knows whether a write sends mail.
 */
export function deriveAnnotations(primitive: ProjectablePrimitive): McpToolAnnotations {
  const derived: McpToolAnnotations =
    (primitive.mutates ?? true)
      ? {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: primitive.idempotent === true,
        }
      : { readOnlyHint: true };
  return { ...derived, ...definedOnly(primitive.mcp?.annotations) };
}

/**
 * The four hint keys, and only booleans: an override's explicit `undefined` must not erase a
 * derived hint, and a key the spec does not define is not published on its behalf.
 */
function definedOnly(annotations: McpToolAnnotations | undefined): McpToolAnnotations {
  if (annotations === undefined) return {};
  const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = annotations;
  return {
    ...(typeof readOnlyHint === 'boolean' ? { readOnlyHint } : {}),
    ...(typeof destructiveHint === 'boolean' ? { destructiveHint } : {}),
    ...(typeof idempotentHint === 'boolean' ? { idempotentHint } : {}),
    ...(typeof openWorldHint === 'boolean' ? { openWorldHint } : {}),
  };
}

/**
 * Project every exposed primitive, SKIPPING the rest. Stable name order.
 *
 * For a swept list — every primitive the registries hold — where the un-exposed ones are the
 * normal case and dropping them is the whole job. A list the author wrote out by hand goes
 * through `toolsListed`, which refuses instead.
 */
export function toolsFrom(primitives: readonly ProjectablePrimitive[]): readonly AnyMcpTool[] {
  return primitives
    .filter(exposed)
    .map(toolFrom)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Project a list the AUTHOR wrote out, REFUSING any primitive that never opted in.
 *
 * Naming a primitive in `defineAppMcp` is the request to expose it, so silence there is a
 * contradiction rather than an opt-out — and a silently dropped entry ships a server whose
 * catalog is missing a tool its author believes is in it. Every offender is collected before
 * throwing so one edit closes all of them.
 */
export function toolsListed(primitives: readonly ProjectablePrimitive[]): readonly AnyMcpTool[] {
  const undeclared = primitives.filter((primitive) => !exposed(primitive));
  if (undeclared.length > 0) {
    // The primitive's own name — the tool's, and what the author greps for.
    throw new McpToolUndeclaredError({ names: undeclared.map((primitive) => primitive.name) });
  }
  return toolsFrom(primitives);
}
