// Project framework `action`s into LLM tool definitions.
//
// This is the SAME projection @ultimat3/mcp performs, in a different wire format: an
// in-app agent calling a tool through the gateway and an external agent calling it over
// MCP both end at the same `invoke`, so they authorize identically. There is no "LLM
// permissions" concept in Ultimate, because there is no second authz system.
//
// `run` below is `ProjectableAction`'s — the projection SEAM, which is what carries `invoke`.
// It is not a member of the action facade: an `action()` is `as`/`tool`/`openapi`/`job`/
// `contract` and the callable itself, and this header claimed `action.run` until 2026-08.
// `asProjectableAction` is what BUILDS that seam out of a real `action()`, so an app writes
// `agent({ tools: [publishPost] })` and never a hand-shaped stand-in — the same union
// @ultimat3/mcp's `ListedPrimitive` accepts, adapted at this package's own edge because the two
// wire formats want different schemas (issue #124).
//
// The JSON Schema type and the projectable-primitive shape are declared here rather than
// imported from @ultimat3/mcp: that package is the same tier, so importing it would be a
// boundary error. Both packages describe the same structural contract.

import type { AnyAction } from '@ultimat3/action';
import { actionName, invoke, isAction } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { isMcpExposed } from '@ultimat3/core';
import { toMcpInputSchema } from '@ultimat3/schema';

/** The JSON Schema subset the framework emits for tool arguments. */
export interface JsonSchema {
  readonly type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  /** A schema, not just a flag: `@ultimat3/schema` emits one for open records. */
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly default?: unknown;
}

/** Anthropic Messages API tool definition shape (`tools[]` on a request). */
export interface LlmTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
  /**
   * Strict mode guarantees the model's `input` validates against the schema exactly.
   * Requires `additionalProperties: false` plus `required` — which every projected action
   * schema already has, so it is on by default.
   */
  readonly strict?: boolean;
}

/** A tool call the model asked for, as it arrives in a `tool_use` content block. */
export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** The result sent back as a `tool_result` block. `isError` is an expected failure. */
export interface LlmToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
}

/**
 * The surface a projectable primitive must expose. Structurally identical to
 * @ultimat3/mcp's `ProjectablePrimitive` — one contract, two wire formats.
 */
export interface ProjectableAction {
  readonly name: string;
  readonly description?: string;
  readonly mcp?: { readonly expose?: boolean; readonly description?: string };
  readonly inputJsonSchema?: JsonSchema;
  run(args: { input: unknown; actor: Actor }): Promise<unknown>;
}

/**
 * What `agent({ tools })` accepts: the real primitive an app writes, or a pre-projected one.
 *
 * The real `action()` comes first because it is what an app has. Until 2026-08 this list took
 * `ProjectableAction` alone, which no `action()` structurally satisfies — an action carries
 * `as`/`tool`/`openapi`/`job`/`contract` and never `run` — so the documented shape
 * `agent({ tools: [publishPost] })` was a `TS2741` and every test in this package hand-built a
 * stand-in, which is why the suite stayed green over an API that did not compile (issue #124).
 * `ProjectableAction` stays in the union for a surface that builds its catalog programmatically
 * and for a test that projects a fake.
 */
export type AgentTool = AnyAction | ProjectableAction;

/**
 * Adapt whatever the author listed. The same shape @ultimat3/mcp's `asProjectable` produces, from
 * the same `invoke` — an in-app agent and an external MCP client end at one execution path, so one
 * policy decides both. It is not shared code and cannot be: `mcp` is this package's own tier, and
 * the two projections narrow the schema differently on purpose (`toWireSchema` publishes only what
 * that server's arg validator will hold a call to; this one publishes the tool schema the Messages
 * API reads).
 *
 * `isAction` is structural against @ultimat3/action's PRIVATE declaration store, so a look-alike
 * carrying `kind: 'action'` cannot take the first branch — it falls through as the already
 * projectable object it claims to be.
 */
export function asProjectableAction(listed: AgentTool): ProjectableAction {
  if (!isAction(listed)) return listed;
  const mcp = listed.mcp;
  return {
    // Throws `X_ACTION_UNREGISTERED` on an unnamed action rather than offering a tool called `''`:
    // a nameless tool is unaddressable by the model, by `runLlmToolCall` and by the author.
    name: actionName(listed),
    ...(mcp === undefined ? {} : { mcp }),
    ...(mcp?.description === undefined ? {} : { description: mcp.description }),
    inputJsonSchema: toMcpInputSchema(listed.input),
    // The actor rides in on the options and `invoke` swaps it inside the one execution path —
    // the action's own `policy` still decides, and its `input:` still parses what the model sent,
    // which is what drops a `{ actor: 'admin' }` the model invented before any handler sees it.
    run: ({ input, actor }) => invoke(listed, input, { surface: 'mcp', actor }),
  };
}

/**
 * The tool's name for an error message, before anything is registered. Never `actionName()`:
 * `X_AGENT_TOOL_UNEXPOSED` is raised at declaration, where an action beside it in the same module
 * has no name yet, and a naming failure there would hide the exposure failure being reported.
 */
export function toolLabel(listed: AgentTool): string {
  return listed.name === '' ? '(an unregistered action)' : listed.name;
}

const EMPTY_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

/** One action → one LLM tool definition. Opt-in via `mcp.expose`, same flag as MCP. */
export function toLlmTool(action: ProjectableAction): LlmTool {
  return {
    name: action.name,
    description:
      action.mcp?.description ?? action.description ?? `Run the "${action.name}" action.`,
    input_schema: action.inputJsonSchema ?? EMPTY_SCHEMA,
    strict: true,
  };
}

/**
 * Every exposed action as a tool definition, in stable name order. The gateway and MCP ask
 * `isMcpExposed` — @ultimat3/core's one predicate — so an in-app agent and an external one are
 * offered exactly the same tools.
 */
export function toLlmTools(actions: readonly ProjectableAction[]): readonly LlmTool[] {
  return actions
    .filter((a) => isMcpExposed(a.mcp))
    .map(toLlmTool)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Execute a model-requested tool call against the projected actions. The actor comes from
 * the request context, NOT from the model — a model cannot name the identity it acts as.
 */
export async function runLlmToolCall(
  actions: readonly ProjectableAction[],
  call: LlmToolCall,
  actor: Actor,
): Promise<LlmToolResult> {
  const action = actions.find((a) => a.name === call.name && isMcpExposed(a.mcp));
  if (action === undefined) {
    return { toolUseId: call.id, content: `unknown tool: ${call.name}`, isError: true };
  }
  try {
    const output = await action.run({ input: call.input, actor });
    return { toolUseId: call.id, content: JSON.stringify(output) };
  } catch (error) {
    // A policy denial is an outcome the model should read and react to, not a crash.
    return { toolUseId: call.id, content: describeFailure(error), isError: true };
  }
}

function describeFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'tool failed';
  const e = error as { code?: unknown; cause?: unknown; fix?: unknown };
  if (typeof e.code !== 'string') return 'tool failed';
  const cause = typeof e.cause === 'string' ? e.cause : 'unknown';
  const fix = typeof e.fix === 'string' ? e.fix : '';
  return fix === '' ? `${e.code}: ${cause}` : `${e.code}: ${cause} (fix: ${fix})`;
}
