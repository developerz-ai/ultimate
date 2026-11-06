// Single responsibility: telling a provider's "the prompt outgrew the window" refusal apart from
// every other non-2xx — the one predicate, the one table of phrases, and the class it raises.
// Both transports call `providerFailure`; the code and title stay in ./error-codes with the rest.

import { UltimateError } from '@ultimat3/core';
import { BILLED_META, billedCall } from './billed';
import { costOf } from './cost';
import './error-codes';
import { AiTransportError } from './errors';
import type { ModelId } from './models';
import { ZERO_USAGE } from './wire';

/** The statuses a context-window refusal arrives with: 400 on every wire, 413 behind some proxies. */
const OVERFLOW_STATUSES: ReadonlySet<number> = new Set([400, 413]);

/**
 * What a provider's message says when the request outgrew the model's window, lower-cased. One
 * row per phrase as each endpoint words it — a phrase, never a status alone: a 400 is also a bad
 * tool schema, and that one must stay `X_AI_PROVIDER_UNAVAILABLE` with its own fix line.
 */
export const CONTEXT_OVERFLOW_PHRASES: readonly string[] = [
  // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum".
  'prompt is too long',
  // Anthropic: "input length and `max_tokens` exceed context limit: …".
  'exceed context limit',
  // OpenAI, vLLM, OpenRouter: "This model's maximum context length is 128000 tokens. …".
  'maximum context length',
  // OpenAI's error code, which some proxies put in the message.
  'context_length_exceeded',
  // OpenAI Responses-era wording: "Your input exceeds the context window of this model."
  'exceeds the context window',
  // Mistral: "… too large for model with 32768 maximum context length".
  'too large for model with',
  // Gemini's OpenAI-compatible endpoint.
  'exceeds the maximum number of tokens allowed',
];

/** Whether a provider's non-2xx answer is the request being longer than the model's window. */
export function isContextOverflow(status: number | undefined, detail: string): boolean {
  if (status === undefined || !OVERFLOW_STATUSES.has(status)) return false;
  const said = detail.toLowerCase();
  return CONTEXT_OVERFLOW_PHRASES.some((phrase) => said.includes(phrase));
}

/**
 * The provider refused the request as over the model's context window. Its own code, not the
 * transport's: the transport code is `retryable`, and every retry of this one re-sends the same
 * request to the same refusal. A refused request billed nothing, and says so on `meta.billed` so
 * a run's meter settles it instead of counting a call whose bill it cannot know.
 */
export class AiContextOverflowError extends UltimateError {
  constructor(input: {
    readonly provider: string;
    readonly model: ModelId;
    readonly status: number;
    readonly detail: string;
  }) {
    super({
      code: 'X_AI_CONTEXT_OVERFLOW',
      cause: `provider "${input.provider}" refused a request to model "${input.model}" as longer than its context window (${input.status}): ${input.detail}`,
      fix: 'compact: { at: 0.6, keepTurns: 2 }   # on the agent — or shorten the prompt, or route to a model whose registerModel row has a larger contextWindow',
      meta: {
        provider: input.provider,
        model: input.model,
        status: input.status,
        detail: input.detail,
        [BILLED_META]: billedCall(ZERO_USAGE, costOf(input.model, ZERO_USAGE)),
      },
    });
  }
}

/** The error a provider's non-2xx answer becomes: an overflow when it says so, else the transport's. */
export function providerFailure(input: {
  readonly provider: string;
  readonly model: ModelId;
  readonly status: number;
  /** Already scrubbed of the credential (`withoutKey`). */
  readonly detail: string;
  readonly envVar: string;
}): UltimateError {
  if (isContextOverflow(input.status, input.detail)) {
    return new AiContextOverflowError(input);
  }
  return new AiTransportError(input);
}
