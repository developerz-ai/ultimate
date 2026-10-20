// Single responsibility: what ONE run of an `agent()` picks from its declaration — the tools it is
// offered (`offerTools()`), the model it runs on (`model` as a function) and the ceilings it runs
// under (`limits()`) — each read from the run's own input and context, and each only ever a
// NARROWING of what the declaration states. Split from ./agent at its line ceiling.

import type { Ctx } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { limitsOf } from './agent-declared';
import type { AgentDef } from './agent-def';
import { AgentToolUndeclaredError } from './agent-errors';
import type { RunCeilings } from './agent-run-limits';
import { narrowCeilings } from './agent-run-limits';
import { AiRequestInvalidError } from './errors';
import { modelForCall } from './model-resolve';
import type { ModelId } from './models';
import { modelSpec } from './models';
import type { PromptVars } from './prompt';
import type { AgentTool, LlmTool, ProjectableAction } from './tools';
import { asProjectableAction, toLlmTools } from './tools';

/** The tools as `runLlmToolCall` consumes them, and as the request offers them. One projection. */
export interface Adapted {
  readonly tools: readonly ProjectableAction[];
  readonly offered: readonly LlmTool[];
}

export function project(tools: readonly AgentTool[]): Adapted {
  const projected = tools.map(asProjectableAction);
  return { tools: projected, offered: toLlmTools(projected) };
}

/** One run's picks, resolved before anything is loaded, reserved or sent. */
export interface PerRun extends RunCeilings {
  readonly model: ModelId;
  readonly adapted: Adapted;
}

type RunArgs<TInput extends StandardSchemaV1> = {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
};

export async function resolvePerRun<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(
  def: AgentDef<TInput, TOutput, V>,
  declared: RunCeilings & { readonly adapted: Adapted },
  args: RunArgs<TInput>,
): Promise<PerRun> {
  const name = def.prompt.ref;
  // The declared budget first, so a bad declaration is refused whether or not a gateway exists —
  // then the run's own ceilings, screened the same way after narrowing.
  limitsOf(declared.budget);
  const ceilings = narrowCeilings(
    name,
    declared,
    def.limits === undefined ? undefined : await def.limits(args),
  );
  limitsOf(ceilings.budget);
  const adapted =
    def.offerTools === undefined
      ? declared.adapted
      : offered(name, declared.adapted, await def.offerTools(args));
  const model = await modelOf(def, args);
  return { ...ceilings, model, adapted };
}

/**
 * The declaration, its prompt, then the gateway's `defaultModel` — the app's three places, with
 * the first one asked per run when it is a function. A per-run id is refused here when it is not
 * registered (`X_AI_MODEL_UNKNOWN`), before `vars()` loads anything: it is data the app read from
 * somewhere, and the gateway's own check would come only after the load.
 */
async function modelOf<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>, args: RunArgs<TInput>): Promise<ModelId> {
  const name = def.prompt.ref;
  if (typeof def.model !== 'function') {
    return modelForCall('agent', name, def.model, def.prompt.model);
  }
  const picked: unknown = await def.model(args);
  if (picked !== undefined && (typeof picked !== 'string' || picked === '')) {
    throw new AiRequestInvalidError({
      detail: `agent "${name}" model() answered ${picked === '' ? 'an empty string' : typeof picked}, not a model id`,
      fix: 'model: ({ input, ctx }) => modelId   # an id your app registerModel-ed, or undefined for the prompt model, then the gateway defaultModel',
    });
  }
  const model = modelForCall('agent', name, picked, def.prompt.model);
  modelSpec(model);
  return model;
}

/**
 * The declared tools narrowed to `names`, in the catalogue's own order (so the request is the same
 * bytes whatever order a rule lists them in, and a provider's prompt cache still reads it back). A
 * repeated name is one tool; a name the declaration does not list is refused, never dropped.
 */
function offered(agent: string, adapted: Adapted, names: unknown): Adapted {
  if (!Array.isArray(names) || names.some((entry) => typeof entry !== 'string')) {
    throw new AiRequestInvalidError({
      detail: `agent "${agent}" offerTools() answered something other than an array of tool names`,
      fix: "offerTools: ({ input, ctx }) => ['toolName']   # names from the agent's tools",
    });
  }
  const wanted = new Set<string>(names);
  const declared = adapted.tools.map((tool) => tool.name);
  const unknown = [...wanted].filter((entry) => !declared.includes(entry));
  if (unknown.length > 0) {
    throw new AgentToolUndeclaredError({ agent, tools: unknown, declared });
  }
  const tools = adapted.tools.filter((tool) => wanted.has(tool.name));
  return { tools, offered: adapted.offered.filter((tool) => wanted.has(tool.name)) };
}
