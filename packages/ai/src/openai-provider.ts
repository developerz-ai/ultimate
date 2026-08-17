// Single responsibility: `openAiProvider()` — a `Provider` speaking the OpenAI chat-completions
// wire FORMAT, against whatever endpoint is configured.
//
// The format matters more than the vendor: Azure OpenAI, vLLM, Ollama, LiteLLM, OpenRouter,
// Together and most self-hosted company gateways serve it, so one provider plus a `baseUrl` is the
// difference between "Ultimate talks to models" and "Ultimate talks to OUR models". The request
// half is ./openai-body, the response half is ./openai-wire; this file owns the socket, the
// credential and the errors.

import type { Secret } from '@ultimat3/core';
import { isSecret, revealSecret } from '@ultimat3/core';
import { detailOf, withoutKey } from './error-body';
import { AiKeyMissingError, AiRequestInvalidError, AiTransportError } from './errors';
import type { ModelId } from './models';
import { chatCompletionBody } from './openai-body';
// Imported for its registration side effect: a provider that cannot price what it serves throws
// X_AI_MODEL_UNKNOWN at the first call, and the specs belong with the format that names them.
import './openai-models';
import type { ChatAnswer } from './openai-wire';
import { ChatCompletionStream, parseChatCompletion } from './openai-wire';
import type {
  GenerateRequest,
  GenerateResult,
  Provider,
  StreamChunk,
  TokenUsage,
} from './provider';
import { costOf, estimateInputTokens, estimateTextTokens, requiresStreaming } from './provider';
import { readSse } from './sse';

const API_KEY_ENV = 'OPENAI_API_KEY';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiProviderInput {
  /**
   * A `Secret` for preference — it redacts by value, so the same key is safe in a log line, an
   * error `meta` and a snapshot. A plain string is accepted because an env var already is one.
   * Reads `OPENAI_API_KEY` when omitted; absent at call time is a labelled throw.
   */
  readonly apiKey?: Secret | string;
  /**
   * The endpoint, minus `/chat/completions`. THIS is what makes the provider vendor-neutral —
   * `http://localhost:11434/v1` is Ollama, `http://vllm:8000/v1` is vLLM, and an Azure deployment
   * URL with its `?api-version=` query works as written: a query on the base is carried onto the
   * request rather than swallowed by the path.
   */
  readonly baseUrl?: string;
  /**
   * The ids this endpoint serves. Required, and the provider's OWN list rather than the registry's,
   * for the reason `AnthropicProvider.models` is: an app's internal model must not be routed
   * somewhere that has never heard of it. On Azure these are DEPLOYMENT names, not model names.
   */
  readonly models: readonly ModelId[];
  /** Extra headers — OpenRouter's attribution pair, a gateway's tenant header. Merged last. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Which header carries the key. `bearer` is `Authorization: Bearer …`, the format's default;
   * `api-key` is Azure's. One knob rather than two ways to pass a credential, so the key stays
   * boxed in a `Secret` until the header is built.
   */
  readonly auth?: 'bearer' | 'api-key';
  /**
   * What this provider is called on a span and in a failure list. Default `openai`. Worth setting
   * when two endpoints speaking this format serve one model — `provider` on the result is the only
   * thing that says which of them answered.
   */
  readonly name?: string;
  /** Injectable so a test can assert the request body without a network. Defaults to `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * A provider for any endpoint speaking the OpenAI chat-completions format.
 *
 * ```ts
 * // OpenAI
 * openAiProvider({ apiKey: openAiKey, models: [...OPENAI_MODEL_IDS] })
 * // a company gateway, vLLM, Ollama — same class, one different field
 * openAiProvider({ apiKey: gatewayKey, baseUrl: 'https://llm.acme.internal/v1', models: ['acme-70b'] })
 * ```
 */
export function openAiProvider(input: OpenAiProviderInput): Provider {
  return new OpenAiProvider(input);
}

class OpenAiProvider implements Provider {
  readonly name: string;
  readonly models: readonly ModelId[];
  private readonly defaultModel: ModelId;
  private readonly config: OpenAiProviderInput;

  constructor(config: OpenAiProviderInput) {
    const [first] = config.models;
    if (first === undefined) {
      // A provider serving nothing can never be routed to, so it is a boot mistake that would
      // otherwise surface as "no provider serves <model>" — a true statement about the wrong thing.
      throw new AiRequestInvalidError({
        detail:
          'openAiProvider was given an empty models list, so the gateway can never route to it',
        fix: 'pass models: [...OPENAI_MODEL_IDS] to openAiProvider, or the ids your endpoint serves',
      });
    }
    this.name = config.name ?? 'openai';
    this.models = config.models;
    this.defaultModel = first;
    this.config = config;
  }

  /**
   * Above `STREAM_ONLY_MAX_TOKENS` this runs the streaming transport and assembles the result,
   * for the reason the Anthropic provider does: a non-streaming request that large sits on an
   * open socket past the HTTP timeout and fails after the completion was generated and billed.
   */
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (requiresStreaming(request)) return this.assemble(request);
    const model = this.modelOf(request);
    const response = await this.send(chatCompletionBody({ request, model, stream: false }), false);
    const answer = parseChatCompletion((await response.json()) as unknown, this.name);
    return this.result(request, model, answer);
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const model = this.modelOf(request);
    const response = await this.send(chatCompletionBody({ request, model, stream: true }), true);
    if (response.body === null) {
      throw new AiTransportError({
        provider: this.name,
        status: response.status,
        detail: 'a streaming response arrived with no body',
      });
    }
    const completion = new ChatCompletionStream(this.name);
    for await (const frame of readSse(response.body)) {
      for (const chunk of completion.push(frame)) yield chunk;
    }
    // A connection cut mid-answer must fail, not resolve: partial text reads as a complete answer,
    // and `end_turn` would be a lie the caller has no way to detect.
    if (!completion.isComplete()) {
      throw new AiTransportError({
        provider: this.name,
        detail: 'the stream ended before a finish reason — the answer is truncated',
      });
    }
    yield { type: 'done', result: this.result(request, model, completion.state()) };
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

  /** One parsed answer, priced. The only place `cost` is applied — the provider owns prices. */
  private result(request: GenerateRequest, model: ModelId, answer: ChatAnswer): GenerateResult {
    const usage = answer.usage ?? estimatedUsage(request, answer.text);
    return {
      model,
      text: answer.text,
      toolCalls: answer.toolCalls,
      stopReason: answer.stopReason,
      stopDetails: answer.stopDetails,
      usage,
      cost: costOf(model, usage),
    };
  }

  /**
   * The model this request is for. The gateway resolves one before it routes, so the fallback is
   * only ever reached by a direct call — and it is this provider's first model, never the
   * framework's `DEFAULT_MODEL`, which names a Claude id no OpenAI-format endpoint serves.
   */
  private modelOf(request: GenerateRequest): ModelId {
    return request.model ?? this.defaultModel;
  }

  /**
   * The one place a request leaves the process. A non-2xx becomes an `AiTransportError` carrying
   * its status, because the gateway decides whether to retry from that status and a body parsed as
   * if it were a message would read as an empty, successful answer.
   */
  private async send(body: Record<string, unknown>, streaming: boolean): Promise<Response> {
    const apiKey = this.apiKey();
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(this.url(), {
      method: 'POST',
      headers: {
        ...(this.config.auth === 'api-key'
          ? { 'api-key': apiKey }
          : { authorization: `Bearer ${apiKey}` }),
        'content-type': 'application/json',
        accept: streaming ? 'text/event-stream' : 'application/json',
        // Last, so a caller can replace the credential header outright for a gateway that wants
        // its own scheme. Nothing here is ever logged.
        ...this.config.headers,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new AiTransportError({
        provider: this.name,
        status: response.status,
        // The endpoint's own message, with the credential scrubbed out of it — `error-body.ts`
        // says why, and both providers call the same pair.
        detail: withoutKey(await detailOf(response), apiKey),
        envVar: API_KEY_ENV,
      });
    }
    return response;
  }

  /**
   * The credential, revealed as late as possible and never stored on the instance. Returned rather
   * than kept, so the only string that exists is the local one `send` puts in a header.
   */
  private apiKey(): string {
    const configured = this.config.apiKey;
    const value = isSecret(configured)
      ? revealSecret(configured)
      : (configured ?? Bun.env[API_KEY_ENV]);
    if (value === undefined || value === '') {
      throw new AiKeyMissingError({ provider: this.name, envVar: API_KEY_ENV });
    }
    return value;
  }

  /**
   * `<baseUrl>/chat/completions`, with any query on the base preserved. Azure's deployment URL
   * carries `?api-version=…`, and appending the path after it would send the version as part of a
   * path segment — a 404 whose cause reads like a wrong deployment name.
   */
  private url(): string {
    const base = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const cut = base.indexOf('?');
    const path = (cut === -1 ? base : base.slice(0, cut)).replace(/\/+$/, '');
    return `${path}/chat/completions${cut === -1 ? '' : base.slice(cut)}`;
  }
}

/**
 * What a call cost when the endpoint reported nothing.
 *
 * Every streamed request asks for usage (`stream_options.include_usage`), and every non-streamed
 * response carries it — but a compatible server that ignores the field leaves the budget
 * reconciling a real call against zero, which refunds the reservation in full and turns the ledger
 * into a decoration. An estimate is wrong by a few percent in the safe direction; zero is wrong by
 * all of it.
 */
export function estimatedUsage(request: GenerateRequest, text: string): TokenUsage {
  return {
    inputTokens: estimateInputTokens(request),
    outputTokens: estimateTextTokens(text),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}
