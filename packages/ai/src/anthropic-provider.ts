// The Anthropic Messages API provider, streaming and not: `anthropicProvider()`, the request body,
// the one `fetch` it sends, and `parseMessage` for a non-streamed answer. The shared shapes are
// ./provider's; ./models owns the per-model rules and ./wire the streamed response half.

import { readAnswerBody } from './answer-body';
import { billedCall } from './billed';
import { assertMediaContent } from './content-blocks';
import { providerFailure } from './context-overflow';
import { costOf, exactCostOf } from './cost';
import { detailOf, withoutKey } from './error-body';
import { AiKeyMissingError, AiRequestInvalidError, AiTransportError } from './errors';
import type { AiFetch } from './fetch-seam';
import { resolveModel } from './model-resolve';
import type { ModelId } from './models';
import { modelSpec, reasoningBody } from './models';
import type { ProviderCacheRow, ProviderPromptCache } from './prompt-cache';
import { promptCacheRule } from './prompt-cache';
import { anthropicPrompt } from './prompt-cache-blocks';
import { screenCacheRows } from './prompt-cache-rows';
import type { GenerateRequest, GenerateResult, Provider, StreamChunk } from './provider';
import { samplingBody } from './sampling';
import { readSse } from './sse';
import { trackSent, trackStreamBill } from './stream-bill';
import { assertToolArguments } from './tool-arguments';
import type { LlmToolCall } from './tools';
import {
  asToolInput,
  MessageStream,
  parseStopDetails,
  parseStopReason,
  parseUsage,
  throwInBandError,
} from './wire';

export interface AnthropicProviderInput {
  /**
   * The ids this endpoint serves — REQUIRED, the app's list, never a built-in one: the gateway
   * routes by membership, and each id is one the app `registerModel`-ed. A direct call names its
   * model or is refused (`X_AI_MODEL_UNRESOLVED`), as `openAiProvider({ models })`'s is.
   */
  readonly models: readonly ModelId[];
  /** Reads `ANTHROPIC_API_KEY` when omitted. Absent at call time is a labelled throw. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /**
   * What this endpoint does with a `cache_control` mark, when `PROMPT_CACHE_RULES` guesses wrong —
   * a proxy that rejects the field: `{ rules: [{ model: '', marks: 'none', session: 'none' }] }`.
   * Read before the table, first match by model prefix. This wire speaks `blocks` or `none`, and
   * carries no session; anything else is `X_AI_REQUEST_INVALID` here.
   */
  readonly promptCache?: ProviderPromptCache;
  /** Injectable so a test can assert the request body without a network. Defaults to `fetch`. */
  readonly fetch?: AiFetch;
}

const ANTHROPIC_VERSION = '2023-06-01';
const API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Above this ceiling a non-streaming request sits on an open socket past the HTTP timeout and
 * fails AFTER the completion was generated and billed. Every current model can be asked for
 * eight times this, so the limit is the transport's, not the model's.
 */
export const STREAM_ONLY_MAX_TOKENS = 16_000;

/** Whether this request has to go over the streaming transport to arrive at all. */
export function requiresStreaming(request: GenerateRequest): boolean {
  const model = resolveModel('provider', request.model);
  return Math.min(request.maxTokens, modelSpec(model).maxOutput) > STREAM_ONLY_MAX_TOKENS;
}

/** The Anthropic Messages API provider — the one way to build one; the class is a type only. */
export function anthropicProvider(input: AnthropicProviderInput): AnthropicProvider {
  return new AnthropicProvider(input);
}

/**
 * The real Messages API shape. The request-surface rules are encoded rather than documented,
 * because getting them wrong is a 400:
 *   - `top_p`/`top_k` are never sent, and `temperature` only to a model whose row takes it
 *     (`ModelSpec.sampling`): a reasoning model rejects all three.
 *   - `thinking.budget_tokens` is REJECTED. Use `output_config.effort`.
 *   - `effort` and adaptive thinking are per-model, and ./models owns which model takes which.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly wire = 'anthropic' as const;
  /** The app's list, never the registry's: a model served elsewhere must not be routed here. */
  readonly models: readonly ModelId[];
  private readonly config: AnthropicProviderInput;
  private readonly cacheRows: readonly ProviderCacheRow[];

  // `| undefined`: plain JS (or a cast) reaches here with no argument, and that is the same boot
  // mistake as an empty list — it gets the coded refusal, never a TypeError on `.models`.
  constructor(config: AnthropicProviderInput | undefined) {
    if (config === undefined || (config.models ?? []).length === 0) {
      // A provider serving nothing can never be routed to — the same boot mistake, refused the
      // same way, as an empty `openAiProvider({ models })`.
      throw new AiRequestInvalidError({
        detail:
          'anthropicProvider() was given an empty models list, so the gateway can never route to it',
        fix: "anthropicProvider({ models: ['<id>'] })   # the ids this endpoint serves, each one your app registerModel-ed",
      });
    }
    this.models = config.models;
    this.config = config;
    this.cacheRows = screenCacheRows('anthropic', config.promptCache);
  }

  /**
   * The model this request is for. The gateway resolves one before it routes; a direct call names
   * one or is refused — this provider's own list is never a fourth place a model comes from.
   */
  private modelOf(request: GenerateRequest): ModelId {
    return resolveModel('provider', request.model);
  }

  /**
   * Above `STREAM_ONLY_MAX_TOKENS` this runs the STREAMING transport and returns the assembled
   * result, rather than refusing. Refusing would leak a transport limit into the API: `llm()`
   * has no streaming path, so a declaration asking for a legal 64k completion would become
   * undeclarable instead of merely awkward — and the caller wanting the whole answer at once is
   * the same caller either way.
   */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = this.modelOf(request);
    if (requiresStreaming({ ...request, model })) return this.assemble(request);
    const response = await this.send(model, request, false);
    return parseMessage(model, await readAnswerBody(response, this.name));
  }

  /** Drive `stream()` to its `done` chunk. It throws on a cut stream, so a partial never lands. */
  private async assemble(request: GenerateRequest): Promise<GenerateResult> {
    for await (const chunk of this.stream(request)) {
      if (chunk.type === 'done') return chunk.result;
    }
    throw new AiTransportError({
      provider: this.name,
      detail: 'the stream completed without a result',
    });
  }

  /**
   * Streaming is mandatory above ~16k `maxTokens`: a non-streaming request that large hits the
   * HTTP timeout before the model finishes. The final `done` chunk carries the assembled
   * result, so a consumer that only wants the answer can ignore every chunk before it.
   */
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const model = this.modelOf(request);
    const response = await this.send(model, request, true);
    if (response.body === null) {
      throw new AiTransportError({
        provider: this.name,
        status: response.status,
        detail: 'a streaming response arrived with no body',
      });
    }
    const message = new MessageStream();
    // A stream that stops before `done` is billed what `message_start` and the deltas said.
    trackStreamBill(request, () => {
      const usage = message.partialUsage();
      return usage === undefined ? undefined : billedCall(usage, exactCostOf(model, usage));
    });
    for await (const frame of readSse(response.body, this.name)) {
      for (const chunk of message.push(frame)) yield chunk;
    }
    // A connection cut mid-answer must fail, not resolve: the partial text reads as a complete
    // answer, and `end_turn` would be a lie the caller has no way to detect.
    if (!message.isComplete()) {
      throw new AiTransportError({
        provider: this.name,
        detail:
          'the stream ended before message_stop, or with a tool call still open — the answer is truncated',
      });
    }
    const { malformed, ...state } = message.state();
    const cost = costOf(model, state.usage);
    // After usage is known, so a finished turn with unreadable arguments fails WITH its bill.
    assertToolArguments({ provider: this.name, model, ...state, malformed, cost });
    yield {
      type: 'done',
      result: { model, ...state, cost, costExact: exactCostOf(model, state.usage) },
    };
  }

  marksPromptCache(model: ModelId): boolean {
    return (
      promptCacheRule('anthropic', this.config.baseUrl, model, this.cacheRows).marks === 'blocks'
    );
  }

  /** The request body. Pure and side-effect free so a test can assert it directly. */
  body(request: GenerateRequest): Record<string, unknown> {
    const model = this.modelOf(request);
    // The blocks pass through untouched below — they ARE this wire's shapes — so this is the screen.
    assertMediaContent(request.messages, { provider: this.name, model });
    const prompt = anthropicPrompt(
      request,
      request.promptCache !== undefined && this.marksPromptCache(model),
    );
    const body: Record<string, unknown> = {
      model,
      max_tokens: Math.min(request.maxTokens, modelSpec(model).maxOutput),
      messages: prompt.messages,
      ...reasoningBody(model, request.effort, request.thinking),
      ...samplingBody('anthropic', model, request),
    };
    if (prompt.system !== undefined) body['system'] = prompt.system;
    if (request.tools !== undefined && request.tools.length > 0) body['tools'] = request.tools;
    if (request.stopSequences !== undefined) body['stop_sequences'] = request.stopSequences;
    return body;
  }

  /**
   * The one place a request leaves the process. A non-2xx becomes an `AiTransportError`
   * carrying its status, because the gateway decides whether to retry from that status and a
   * body parsed as if it were a message would read as an empty, successful answer.
   */
  private async send(model: ModelId, request: GenerateRequest, stream: boolean): Promise<Response> {
    const body = { ...this.body(request), stream };
    const { signal } = request;
    const apiKey = this.config.apiKey ?? Bun.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === '') {
      throw new AiKeyMissingError({ provider: this.name, envVar: API_KEY_ENV });
    }
    const doFetch: AiFetch = this.config.fetch ?? fetch;
    const url = `${this.config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
    // From here an abort costs the prompt (`stream-bill.ts`): the request is on its way.
    trackSent(request, model);
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        accept: body['stream'] === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      // Attached only when the caller has one: `exactOptionalPropertyTypes`, and an explicit
      // `signal: undefined` is a different value to some fetch implementations.
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      // An overflow or the transport's code — `context-overflow.ts` decides, for both wires.
      throw providerFailure({
        provider: this.name,
        model,
        status: response.status,
        // The endpoint's own message, with the credential scrubbed out of it — the same rule the
        // OpenAI-format provider follows, and for the same reason: a proxy echoing the request
        // headers into its 4xx body is the one path by which `x-api-key` reaches an error.
        detail: withoutKey(await detailOf(response), apiKey),
        envVar: API_KEY_ENV,
      });
    }
    return response;
  }
}

/** Map a Messages API response onto `GenerateResult`. Exported so tests can drive it. */
export function parseMessage(model: ModelId, input: unknown): GenerateResult {
  // `null`, an array or a string is no message: read as one it threw a bare TypeError, or
  // resolved as an empty answer — `openai-wire.ts`'s `parseChatCompletion` refuses the same.
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AiTransportError({
      provider: 'anthropic',
      detail: 'the response body is not a JSON object',
    });
  }
  const raw = input as Record<string, unknown>;
  // A 200 carrying an `error` object instead of an answer — how a gateway in front of a model
  // reports a fault it noticed after the headers were sent. Read as a message it is an empty,
  // successful answer, which is the one outcome nothing downstream can detect; the STREAMED half
  // of this same provider has always refused it.
  throwInBandError(raw);
  const content = Array.isArray(raw['content']) ? raw['content'] : [];
  let text = '';
  const toolCalls: LlmToolCall[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') text += b['text'];
    if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
      toolCalls.push({
        id: b['id'],
        name: b['name'],
        // Parsed, never cast: `input` is untrusted, and a string under `Record<string, unknown>`
        // is a lie every later reader indexes into. The streamed half already parses it.
        input: asToolInput(b['input']),
      });
    }
  }
  const usage = parseUsage(raw['usage']);
  const stopDetails = parseStopDetails(raw['stop_details']);
  return {
    model,
    text,
    toolCalls,
    // A refusal detail is a refusal whatever the stop field says: `parseStopReason` answers
    // `end_turn` for a spelling this build has never seen, and `llm()` branches on the REASON —
    // `stopDetails` has no reader that can refuse — so the pair would arrive as a complete answer
    // that happens to be empty. The OpenAI-format read has always forced it.
    stopReason: stopDetails === undefined ? parseStopReason(raw['stop_reason']) : 'refusal',
    stopDetails,
    usage,
    cost: costOf(model, usage),
    costExact: exactCostOf(model, usage),
  };
}
