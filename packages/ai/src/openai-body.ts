// Single responsibility: one chat-completions request body, assembled from a `GenerateRequest`.
// Pure and side-effect free, so what leaves the process is asserted directly in a test.
//
// The per-model rules live in the model's spec, never in an `if` here — same rule as
// `reasoningBody()`: adding a model an endpoint serves is a `registerModel` row, not a branch.

import { AiRequestInvalidError } from './errors';
import type { Effort, ModelId, ThinkingMode } from './models';
import { modelSpec } from './models';
import { toOpenAiMessages, toOpenAiTools, toolChoiceFor } from './openai-messages';
import type { GenerateRequest } from './provider';

export interface ChatCompletionBodyInput {
  readonly request: GenerateRequest;
  /** Already resolved — the gateway picks the model, the provider never guesses mid-request. */
  readonly model: ModelId;
  readonly stream: boolean;
}

/**
 * The body. What is deliberately absent is as load-bearing as what is present:
 *   - no `temperature` / `top_p` / `presence_penalty`. Steering is the prompt's job, and a sampling
 *     knob on a reasoning model in this family is a 400.
 *   - no `response_format`. The output schema is projected into the `respond` tool by `llm()`, and
 *     that projection is the framework's ONE structured-output path — see the README.
 *   - `max_completion_tokens`, never the deprecated `max_tokens`, which current reasoning models
 *     reject outright.
 */
export function chatCompletionBody(input: ChatCompletionBodyInput): Record<string, unknown> {
  const { request, model, stream } = input;
  const spec = modelSpec(model);
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(request.system, request.messages),
    max_completion_tokens: Math.min(request.maxTokens, spec.maxOutput),
    ...reasoningFields(model, request.effort, request.thinking),
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body['tools'] = toOpenAiTools(request.tools);
    const choice = toolChoiceFor(request.tools);
    if (choice !== undefined) body['tool_choice'] = choice;
  }
  if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
    body['stop'] = request.stopSequences;
  }
  if (stream) {
    body['stream'] = true;
    // Without this the final chunk carries no `usage` and the budget reconciles against nothing —
    // a full refund of the reservation for a call that really happened. It is one field and it is
    // the difference between a ledger and a decoration.
    body['stream_options'] = { include_usage: true };
  }
  return body;
}

/**
 * The reasoning half, shaped for one model. Refused LOCALLY when the model's spec says the endpoint
 * has no such control, for the reason models.ts states: a round trip to learn a rule the registry
 * already holds costs latency and teaches nothing.
 *
 * `reasoning_effort` is one field carrying two of the framework's controls, so asking for both is
 * refused rather than resolved — a declaration that reads `effort: 'max'` next to
 * `thinking: 'disabled'` cannot have both, and picking one silently is the failure nobody sees.
 */
export function reasoningFields(
  model: ModelId,
  effort: Effort | undefined,
  thinking: ThinkingMode | undefined,
): Record<string, unknown> {
  const rules = modelSpec(model).reasoning;
  if (effort !== undefined && !rules.effort) {
    throw new AiRequestInvalidError({
      detail: `model "${model}" is registered with no effort control, so reasoning_effort cannot be sent to it`,
      fix: 'drop effort from definePrompt, or re-register the model with reasoning: { effort: true } if its endpoint accepts reasoning_effort',
    });
  }
  if (thinking === 'adaptive' && !rules.adaptive) {
    throw new AiRequestInvalidError({
      detail: `model "${model}" has no adaptive thinking; the OpenAI format's only depth control is reasoning_effort`,
      fix: 'drop thinking from definePrompt and set effort instead, or route the prompt to a model registered with reasoning: { adaptive: true }',
    });
  }
  if (thinking === 'disabled' && effort !== undefined) {
    throw new AiRequestInvalidError({
      detail: `model "${model}" writes both thinking and effort onto one reasoning_effort field, and the request asked for both`,
      fix: "drop one from definePrompt: keep thinking: 'disabled', or keep effort",
    });
  }
  // `none` IS the off switch on this wire, and a model with no effort control has nothing to
  // switch off — so it sends nothing rather than a field the endpoint would reject.
  if (thinking === 'disabled') return rules.effort ? { reasoning_effort: 'none' } : {};
  if (effort !== undefined) return { reasoning_effort: effort };
  // Nothing asked for, nothing sent. Adaptive depth is the server's own default here, so emitting
  // anything for it would make a defaulted control indistinguishable from a declared one.
  return {};
}
