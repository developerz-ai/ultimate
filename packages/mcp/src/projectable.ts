// A real `action` or `query` → the `ProjectablePrimitive` this package projects.
//
// ONE adapter, two callers — the registry sweep and the written-out list — so writing a
// primitive out is a different way to NAME a tool, never a second way to run one.

import type { AnyAction } from '@ultimat3/action';
import { actionName, invoke, isAction } from '@ultimat3/action';
import { isMcpExposed } from '@ultimat3/core';
import type { AnyQuery } from '@ultimat3/query';
import { isQuery, queryName, sourceFor } from '@ultimat3/query';
import { asCallerContext } from './caller-context';
import type { McpExposure, ProjectablePrimitive } from './from-action';
import { toWireSchema } from './input-schema';

/**
 * What `defineAppMcp`'s `actions:`/`queries:` accept.
 *
 * The real primitives come first because they are what an app writes: `actions: [publishPost]`.
 * Until 2026-08 this list took `ProjectablePrimitive` alone, which no `action()` or `query()`
 * structurally satisfies — they carry `as`/`tool`, never `run` — so the only value that could
 * reach `X_MCP_TOOL_UNDECLARED` was a hand-built fake, and the gate refused nothing an app could
 * actually declare. `ProjectablePrimitive` stays in the union for surfaces that build their
 * catalog programmatically (`@ultimat3/admin`) and for tests that project a stand-in.
 */
export type ListedPrimitive = AnyAction | AnyQuery | ProjectablePrimitive;

/**
 * Adapt whatever the author listed.
 *
 * `isAction`/`isQuery` are structural against each package's PRIVATE declaration store, so a
 * look-alike carrying `kind: 'action'` cannot take either branch — it falls through as the
 * already-projectable object it claims to be, and is projected verbatim.
 */
export function asProjectable(listed: ListedPrimitive): ProjectablePrimitive {
  if (isAction(listed)) return primitiveFromAction(listed);
  if (isQuery(listed)) return primitiveFromQuery(listed);
  return listed;
}

export function primitiveFromAction(target: AnyAction): ProjectablePrimitive {
  const exposure = exposureOf(target.mcp);
  return {
    // Throws `X_ACTION_UNREGISTERED` on an unnamed action rather than projecting a tool called
    // `''`: a nameless tool is unaddressable by the scope map, by `tools/call`, and by the author.
    name: actionName(target),
    ...(exposure === undefined ? {} : { mcp: exposure }),
    ...(exposure?.description === undefined ? {} : { description: exposure.description }),
    inputJsonSchema: toWireSchema(target.input),
    mutates: true,
    // The actor rides in on the options: `invoke` swaps it inside the one execution path.
    run: ({ input, actor }) => invoke(target, input, { surface: 'mcp', actor }),
  };
}

export function primitiveFromQuery(target: AnyQuery): ProjectablePrimitive {
  const exposure = exposureOf(target.mcp);
  return {
    name: queryName(target),
    ...(exposure === undefined ? {} : { mcp: exposure }),
    ...(exposure?.description === undefined ? {} : { description: exposure.description }),
    inputJsonSchema: toWireSchema(target.input),
    mutates: false,
    run: ({ input, actor }) =>
      asCallerContext(actor, async () => {
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
 * An action and a query declare MCP exposure with the same fields, so one typed path reads
 * both. Narrow on purpose, through `@ultimat3/core`'s `isMcpExposed`: only a literal
 * `expose: true` counts, so nothing is exposed by accident — an undeclared `mcp` block yields
 * no exposure at all.
 *
 * `visibleTo` travels with it, and must: it is OUTCOME 1's only declaration surface for a
 * projected primitive. Dropping it here — which this function did until 2026-08 — left
 * `ToolRegistry`'s role gate enforcing a field no action or query could ever set, so every
 * projected tool was visible to every caller and the first outcome existed only for the
 * hand-written tools that build their own `McpTool`.
 */
function exposureOf(declared: DeclaredMcp | undefined): McpExposure | undefined {
  if (declared === undefined) return undefined;
  return {
    expose: isMcpExposed(declared),
    ...(declared.description === undefined ? {} : { description: declared.description }),
    ...(declared.visibleTo === undefined ? {} : { visibleTo: declared.visibleTo }),
  };
}

/** `ActionMcp` and `QueryMcp` are the same shape; restating it binds to neither. */
interface DeclaredMcp {
  readonly expose: boolean;
  readonly description?: string;
  readonly visibleTo?: readonly string[];
}
