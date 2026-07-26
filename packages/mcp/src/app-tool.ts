// The AUTHORING shape of a hand-written app tool, and its normalization into a runtime one.
//
// An app declares tools as a NAMED RECORD — the key is the tool name, so the name is written
// once — and gives a Standard Schema plus a `resource:verb` permission. None of that is what the
// registry runs, so this file is the mapping to `ProjectablePrimitive`, which `toolsFrom` then
// projects exactly as it projects an action. One projection, not two.
//
// The load-bearing line is `guard(...)` in `run` below: it is the SAME function `runAction` calls
// for an HTTP request, reached through the same `@ultimat3/action` policy gate. A hand-written
// tool therefore has no authz of its own — it borrows the action tier's, so a rule change cannot
// apply to routes and miss tools.

import { actorOf, guard } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import { useContext, withChildContext } from '@ultimat3/core';
import type { KnownPermission } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { McpToolUnsafeError } from './errors';
import type { ProjectablePrimitive } from './from-action';
import { toWireSchema } from './input-schema';
import type { McpRole } from './registry';

export interface AppToolArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  /** The ambient request context, with `actor` set to the MCP caller. */
  readonly ctx: Ctx;
}

export interface AppToolDefinition<TInput extends StandardSchemaV1 = StandardSchemaV1> {
  /** Says what it does AND whether it costs money or sends mail. Agents read only this. */
  readonly description: string;
  /** A Standard Schema. The tool's only argument contract, published by `tools/list`. */
  readonly input: TInput;
  /** An existing `resource:verb` permission. Never a new rule invented for MCP. */
  readonly policy: KnownPermission;
  /** Catalog visibility, not authz — the policy still decides. */
  readonly visibleTo?: readonly McpRole[];
  /**
   * Defaults to `true`. Fail-closed on purpose: an unmarked tool is metered in the strict
   * rate-limit bucket, so forgetting the flag costs throughput rather than safety.
   */
  readonly destructive?: boolean;
  // Method syntax (not a property) so a tool declared with narrower args stays assignable.
  handle(args: AppToolArgs<TInput>): unknown;
}

/** Schema-erased view — what the normalizer walks once the per-tool types have done their job. */
export interface AnyAppToolDefinition {
  readonly description: string;
  readonly input: StandardSchemaV1;
  readonly policy: KnownPermission;
  readonly visibleTo?: readonly McpRole[];
  readonly destructive?: boolean;
  handle(args: { readonly input: unknown; readonly ctx: Ctx }): unknown;
}

/**
 * The authored record, keyed by tool name. Written as a mapped type over the schemas so each
 * tool's `handle` infers `input` from that tool's own schema instead of every tool sharing one.
 */
export type AppTools<TSchemas extends Readonly<Record<string, StandardSchemaV1>>> = {
  readonly [K in keyof TSchemas]: AppToolDefinition<TSchemas[K]>;
};

/** Normalize the authored record into primitives, in the record's own key order. */
export function appToolPrimitives(
  tools: Readonly<Record<string, AnyAppToolDefinition>>,
): readonly ProjectablePrimitive[] {
  return Object.entries(tools).map(([name, def]) => appToolPrimitive(name, def));
}

export function appToolPrimitive(name: string, def: AnyAppToolDefinition): ProjectablePrimitive {
  // Boot-time, not call-time: an unguarded tool must never reach a client, and a server that
  // starts and then refuses every call is indistinguishable from one that is merely broken.
  if (typeof def.policy !== 'string' || def.policy.length === 0) {
    throw new McpToolUnsafeError({ name });
  }
  const policy = can(def.policy);
  const visibleTo = def.visibleTo;

  return {
    name,
    description: def.description,
    // Authoring one implies exposing it — a hand-written tool exists only to be a tool.
    mcp: {
      expose: true,
      description: def.description,
      ...(visibleTo !== undefined ? { visibleTo } : {}),
    },
    inputJsonSchema: toWireSchema(def.input),
    mutates: def.destructive ?? true,
    run: ({ input, actor }) =>
      // The caller is the actor for the WHOLE call. A child context is how the framework
      // impersonates, so the policy subject and whatever `handle` reads off `ctx.actor` are
      // the same identity by construction rather than by two call sites agreeing.
      withChildContext({ actor }, async () => {
        const ctx = useContext();
        guard(policy, { actor: actorOf(ctx), input, ctx, action: name }, 'mcp');
        return def.handle({ input, ctx });
      }),
  };
}
