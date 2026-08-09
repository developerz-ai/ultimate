// `include: 'exposed'` — project straight from the primitive registries.
//
// "Define once, project everywhere". The action and query registries already know which
// primitives declared `mcp: { expose: true }`; re-listing them in `defineAppMcp` copies that
// knowledge into a second place, and a copy is a thing that goes stale silently — an action
// gains `expose`, its tool never appears, and nothing fails.
//
// Both registries are read through the same `describe`/`list` boundary `dev-host.ts` already
// uses, and every projected primitive still runs through `invoke` / `sourceFor`, so the
// registry shortcut buys convenience and changes no execution path.

import type { AnyAction } from '@ultimat3/action';
import { actionName, invoke, listActions } from '@ultimat3/action';
import { withChildContext } from '@ultimat3/core';
import type { AnyQuery } from '@ultimat3/query';
import { listQueries, queryName, sourceFor } from '@ultimat3/query';
import type { McpExposure, ProjectablePrimitive } from './from-action';
import { toWireSchema } from './input-schema';

/**
 * Every registered action and query, as projectable primitives. `toolsFrom` applies the opt-in
 * filter, so this deliberately does NOT filter: one place decides what "exposed" means.
 *
 * Read eagerly, at the moment `defineAppMcp` runs — register the app's primitives first.
 */
export function exposedPrimitives(): readonly ProjectablePrimitive[] {
  return [...listActions().map(primitiveFromAction), ...listQueries().map(primitiveFromQuery)];
}

function primitiveFromAction(target: AnyAction): ProjectablePrimitive {
  const exposure = exposureOf(target.mcp);
  return {
    name: actionName(target),
    ...(exposure === undefined ? {} : { mcp: exposure }),
    ...(exposure?.description === undefined ? {} : { description: exposure.description }),
    inputJsonSchema: toWireSchema(target.input),
    mutates: true,
    // The actor rides in on the options: `invoke` swaps it inside the one execution path.
    run: ({ input, actor }) => invoke(target, input, { surface: 'mcp', actor }),
  };
}

function primitiveFromQuery(target: AnyQuery): ProjectablePrimitive {
  const exposure = exposureOf(target.mcp);
  return {
    name: queryName(target),
    ...(exposure === undefined ? {} : { mcp: exposure }),
    ...(exposure?.description === undefined ? {} : { description: exposure.description }),
    inputJsonSchema: toWireSchema(target.input),
    mutates: false,
    run: ({ input, actor }) =>
      withChildContext({ actor }, async () => {
        // `sourceFor` is the authorized front half of `runQuery` — validate, guard, build —
        // and is what `live`, `paginate` and `explain` build on too. Executed without the
        // cache tiers on purpose: an agent diffing two tool calls must be reading the rows,
        // not a TTL.
        const source = await sourceFor(target, input);
        return source.execute();
      }),
  };
}

/**
 * An action and a query declare MCP exposure with the same two fields, so one typed path
 * reads both. Narrow on purpose: only a literal `expose: true` counts, so nothing is
 * exposed by accident — an undeclared `mcp` block yields no exposure at all.
 */
function exposureOf(declared: DeclaredMcp | undefined): McpExposure | undefined {
  if (declared === undefined) return undefined;
  return {
    expose: declared.expose === true,
    ...(declared.description === undefined ? {} : { description: declared.description }),
  };
}

/** `ActionMcp` and `QueryMcp` are the same shape; restating it binds to neither. */
interface DeclaredMcp {
  readonly expose: boolean;
  readonly description?: string;
}
