// Single responsibility: one chat-completions request body, assembled from a `GenerateRequest`.
// Pure and side-effect free, so what leaves the process is asserted directly in a test.
//
// The per-model rules live in the model's spec, never in an `if` here — same rule as
// `reasoningBody()`: adding a model an endpoint serves is a `registerModel` row, not a branch.

import { assertMediaContent } from './content-blocks';
import { AiRequestInvalidError } from './errors';
import type { Effort, ModelId, ThinkingMode } from './models';
import { modelSpec } from './models';
import { toOpenAiMessages, toOpenAiTools, toolChoiceFor } from './openai-messages';
import { promptCacheRule, SESSION_KEY_MAX } from './prompt-cache';
import type { GenerateRequest } from './provider';

export interface ChatCompletionBodyInput {
  readonly request: GenerateRequest;
  /** Already resolved — the gateway picks the model, the provider never guesses mid-request. */
  readonly model: ModelId;
  /** The provider's `name`, so a content refusal names the endpoint that cannot take the block. */
  readonly provider: string;
  readonly stream: boolean;
  /** The endpoint, for `PROMPT_CACHE_RULES` — which host this is decides what a cache hint sends. */
  readonly baseUrl?: string | undefined;
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
  const { request, model, stream, provider } = input;
  const spec = modelSpec(model);
  assertMediaContent(request.messages, { provider, model });
  const hint = request.promptCache;
  const rule = promptCacheRule('openai', input.baseUrl, model);
  const marked = hint !== undefined && rule.marks === 'parts';
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(request.system, request.messages, { provider, model }, marked),
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
  // OpenAI's own grouping key. OpenRouter's session rides a header instead (`sessionHeaders`), so
  // the body never carries two spellings of one key.
  if (hint?.session !== undefined && rule.session === 'prompt_cache_key') {
    body['prompt_cache_key'] = sessionKey(hint.session);
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

/** The headers a cache hint adds for this endpoint and model: OpenRouter's stickiness key, or none. */
export function sessionHeaders(
  request: GenerateRequest,
  model: ModelId,
  baseUrl: string | undefined,
): Readonly<Record<string, string>> {
  const session = request.promptCache?.session;
  if (session === undefined) return {};
  if (promptCacheRule('openai', baseUrl, model).session !== 'x-session-id') return {};
  return { 'x-session-id': sessionKey(session) };
}

/**
 * Refused, never cut: a truncated key is a DIFFERENT key that two tenants can share, and a control
 * character in a header value is a request the runtime refuses with no code at all.
 */
function sessionKey(session: string): string {
  if (session !== '' && session.length <= SESSION_KEY_MAX && !/[^\x20-\x7e]/.test(session)) {
    return session;
  }
  throw new AiRequestInvalidError({
    detail: `the prompt-cache session key is ${session.length} characters; it must be 1 to ${SESSION_KEY_MAX} printable ASCII characters to travel as a header`,
    fix: "promptCache: { session: 'kb-agent' }   # a short, stable, non-secret name for the runs that share a prefix",
  });
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
  // The row says reasoning cannot be switched off, whatever the wire would spell the switch as.
  if (thinking === 'disabled' && rules.disableThinkingUpTo === 'never') {
    throw new AiRequestInvalidError({
      detail: `model "${model}" is registered with reasoning always on (disableThinkingUpTo: 'never'), so reasoning_effort: 'none' cannot be sent to it`,
      fix: "effort: 'low'   # in definePrompt, in place of thinking: 'disabled'",
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
