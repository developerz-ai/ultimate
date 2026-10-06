// `EchoProvider`: the deterministic `Provider` tests, evals and `x dev` without a key run on. Apart
// from ./provider, which owns the real Messages API, because a double and the socket it stands in
// for are two jobs — and the request half had reached its line ceiling holding both.

import { resolveModel } from './model-resolve';
import type { ModelId } from './models';
import { modelIds } from './models';
import type {
  AiMessage,
  GenerateRequest,
  GenerateResult,
  Provider,
  StreamChunk,
  TokenUsage,
} from './provider';
import { costOf, estimateTextTokens, estimateTokens, messageText } from './provider';

export interface EchoProviderInput {
  /** Fixed replies keyed by the last user message, for eval fixtures. */
  readonly replies?: Readonly<Record<string, string>>;
  /** Fallback when no key matches. Defaults to echoing the last user message. */
  readonly fallback?: (prompt: string) => string;
  readonly tokensPerCall?: number;
}

/**
 * Deterministic provider. Same input, same output, same usage — which is what makes an eval
 * suite a test rather than a sample. Token counts are derived from length, so a budget test
 * can assert a refusal without a network.
 */
export class EchoProvider implements Provider {
  readonly name = 'echo';
  /**
   * A getter over the whole registry, not a snapshot: the test double has to serve whatever the
   * test registered, and a field read at construction time would miss a model registered after.
   */
  get models(): readonly ModelId[] {
    return modelIds();
  }

  private readonly config: EchoProviderInput;

  constructor(config: EchoProviderInput = {}) {
    this.config = config;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = resolveModel('echo-provider', request.model);
    const prompt = lastUserMessage(request.messages);
    const text = this.fixedReply(prompt) ?? this.config.fallback?.(prompt) ?? prompt;
    const usage: TokenUsage = {
      inputTokens: this.config.tokensPerCall ?? estimateTokens({ ...request, model }),
      outputTokens: estimateTextTokens(text),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return {
      model,
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      stopDetails: undefined,
      usage,
      cost: costOf(model, usage),
    };
  }

  /**
   * The fixture reply for this prompt. `Object.hasOwn`, never `replies?.[prompt]`: the key is
   * MESSAGE TEXT, so a prompt of `toString` read a function off the prototype chain and returned
   * it as the model's answer — a double that answers with JS source is worse than one that cannot.
   */
  private fixedReply(prompt: string): string | undefined {
    const { replies } = this.config;
    if (replies === undefined || !Object.hasOwn(replies, prompt)) return undefined;
    return replies[prompt];
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const result = await this.generate(request);
    // One word per chunk: enough to exercise a consumer's assembly logic.
    for (const word of result.text.split(' ')) {
      if (word !== '') yield { type: 'text', text: `${word} ` };
    }
    yield { type: 'done', result };
  }
}

function lastUserMessage(messages: readonly AiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === 'user') return messageText(message);
  }
  return '';
}
