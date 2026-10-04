// A real `action` or `query` → the `ProjectablePrimitive` this package projects.
//
// ONE adapter, two callers — the registry sweep and the written-out list — so writing a
// primitive out is a different way to NAME a tool, never a second way to run one.

import type { AnyAction } from '@ultimat3/action';
import {
  guardBeforeInput as actionGuardBeforeInput,
  actionName,
  actorOf,
  invoke,
  isAction,
} from '@ultimat3/action';
import { type Actor, isMcpExposed, useContext } from '@ultimat3/core';
import type { AnyQuery } from '@ultimat3/query';
import {
  isQuery,
  guardBeforeInput as queryGuardBeforeInput,
  queryName,
  readAnswer,
  sourceFor,
} from '@ultimat3/query';
import { toWireOutputSchema, toWireSchema } from '@ultimat3/schema';
import { asCallerContext } from './caller-context';
import type { McpExposure, ProjectablePrimitive } from './from-action';
import { takeIdempotencyKeyArg, withIdempotencyKeyArg } from './idempotency-arg';
import type { McpListParams } from './list-params';
import type { McpToolAnnotations } from './registry';
import type { JsonSchema } from './wire';

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
  // Throws `X_ACTION_UNREGISTERED` on an unnamed action rather than projecting a tool called
  // `''`: a nameless tool is unaddressable by the scope map, by `tools/call`, and by the author.
  const name = actionName(target);
  const wire = toWireSchema(target.input);
  // `idempotent: true` is honoured on this surface exactly as over HTTP: the caller's key reaches
  // `invoke`, which files it under the action, the caller and the key (`idempotencyKeyFor`).
  const keyed = target.describe().idempotent;
  const output = toWireOutputSchema(target.output);
  return {
    name,
    ...(exposure === undefined ? {} : { mcp: exposure }),
    ...(exposure?.description === undefined ? {} : { description: exposure.description }),
    inputJsonSchema: keyed ? withIdempotencyKeyArg(name, wire) : wire,
    ...(output === undefined ? {} : { outputJsonSchema: output }),
    mutates: true,
    idempotent: keyed,
    // The same gate `invoke` opens with, asked by the server before it answers `invalid-args`.
    admit: (actor: Actor) =>
      asCallerContext(actor, () => {
        const ctx = useContext();
        actionGuardBeforeInput(target.policy, { actor: actorOf(ctx), ctx, action: name }, 'mcp');
      }),
    // The actor rides in on the options: `invoke` swaps it inside the one execution path.
    run: keyed
      ? ({ input: args, actor }) => {
          const { input, idempotencyKey } = takeIdempotencyKeyArg(args);
          return invoke(target, input, { surface: 'mcp', actor, idempotencyKey });
        }
      : ({ input, actor }) => invoke(target, input, { surface: 'mcp', actor }),
  };
}

export function primitiveFromQuery(target: AnyQuery): ProjectablePrimitive {
  const exposure = exposureOf(target.mcp);
  // A `single: true` read answers ONE row, or not-found — what its route answers (404) and what
  // `tool().read()` answers. Handing an agent `[]` for a missing id said "found, and empty".
  const single = target.single === true;
  // Only a query that DECLARED its rows (`rows: Post.$schema`) has a known answer shape. A list
  // read answers the rows as a list, so the structured copy is `{ rows }` — `structuredContent`
  // is an object by the spec; a single read's answer already IS the object.
  const output = single ? toWireOutputSchema(target.rows) : toRowsOutputSchema(target.rows);
  const name = queryName(target);
  return {
    name,
    ...(exposure === undefined ? {} : { mcp: exposure }),
    ...(exposure?.description === undefined ? {} : { description: exposure.description }),
    inputJsonSchema: toWireSchema(target.input),
    ...(output === undefined
      ? {}
      : { outputJsonSchema: output, ...(single ? {} : { outputWrap: 'rows' }) }),
    mutates: false,
    // `sourceFor`'s opening gate, on the surface it runs on ('server'), asked before `invalid-args`.
    admit: (actor: Actor) =>
      asCallerContext(actor, () => {
        const ctx = useContext();
        queryGuardBeforeInput(target.policy, { actor: actorOf(ctx), ctx, query: name }, 'server');
      }),
    run: ({ input, actor }) =>
      asCallerContext(actor, async () => {
        // `sourceFor` is the authorized front half of `runQuery` — validate, guard, build —
        // and is what `live`, `paginate` and `explain` build on too. Executed without the
        // cache tiers on purpose: an agent diffing two tool calls must be reading the rows,
        // not a TTL.
        const source = await sourceFor(target, input);
        // `@ultimat3/query`'s one rule for what a read answers: rows, or a single read's row.
        return readAnswer(target, await source.execute());
      }),
  };
}

/** `{ rows: [<row>] }` — a query's answer as `structuredContent`. `undefined` when no row schema. */
export function toRowsOutputSchema(rows: unknown): JsonSchema | undefined {
  if (rows === undefined) return undefined;
  const row = toWireOutputSchema(rows);
  if (row === undefined) return undefined;
  return {
    type: 'object',
    properties: { rows: { type: 'array', items: row } },
    required: ['rows'],
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
    ...(declared.listParams === undefined ? {} : { listParams: declared.listParams }),
    ...(declared.title === undefined ? {} : { title: declared.title }),
    ...(declared.annotations === undefined ? {} : { annotations: declared.annotations }),
  };
}

/** `ActionMcp` and `QueryMcp` are the same shape; restating it binds to neither. */
interface DeclaredMcp {
  readonly expose: boolean;
  readonly description?: string;
  readonly visibleTo?: readonly string[];
  /** `QueryMcp` only; an action has no list to compose. */
  readonly listParams?: McpListParams;
  readonly title?: string;
  readonly annotations?: McpToolAnnotations;
}
