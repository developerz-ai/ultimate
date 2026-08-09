// Project framework `action`s into LLM tool definitions.
//
// This is the SAME projection @ultimat3/mcp performs, in a different wire format: an
// in-app agent calling a tool through the gateway and an external agent calling it over
// MCP both end at `action.run`, so they authorize identically. There is no "LLM
// permissions" concept in Ultimate, because there is no second authz system.
//
// The JSON Schema type and the projectable-primitive shape are declared here rather than
// imported from @ultimat3/mcp: that package is the same tier, so importing it would be a
// boundary error. Both packages describe the same structural contract.

import type { Actor } from '@ultimat3/core';

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

/** Every exposed action as a tool definition, in stable name order. */
export function toLlmTools(actions: readonly ProjectableAction[]): readonly LlmTool[] {
  return actions
    .filter((a) => a.mcp?.expose === true)
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
  const action = actions.find((a) => a.name === call.name && a.mcp?.expose === true);
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
