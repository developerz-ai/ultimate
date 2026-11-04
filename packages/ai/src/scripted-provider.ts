// `scriptedProvider()`: the test double that answers with turns written in advance — text, one
// tool call, several, or the `respond` answer — and records every request. Apart from
// ./echo-provider because echo cannot call a tool, and a loop under test has to be driven by one.

import { UltimateError } from '@ultimat3/core';
import { costOf, exactCostOf } from './cost';
import { resolveModel } from './model-resolve';
import type { ModelId } from './models';
import { modelIds } from './models';
import type {
  GenerateRequest,
  GenerateResult,
  Provider,
  StopReason,
  StreamChunk,
  TokenUsage,
} from './provider';
import { estimateTextTokens, estimateTokens } from './provider';
import { RESPOND } from './respond';
import type { LlmToolCall } from './tools';

/** One tool call a turn makes. `input` defaults to `{}`. */
export interface ScriptedCall {
  readonly call: string;
  readonly input?: Record<string, unknown>;
}

/**
 * One model turn. `stop` overrides the stop reason the form implies (`end_turn` for text,
 * `tool_use` otherwise) — `'max_tokens'` scripts a cut-off turn.
 */
export type ScriptedTurn = (
  | { readonly text: string }
  | ScriptedCall
  | { readonly calls: readonly ScriptedCall[] }
  | { readonly answer: Record<string, unknown> }
) & { readonly stop?: StopReason };

export interface ScriptedProviderInput {
  /** Answered in order, one per provider call. One call past the end is `X_AI_SCRIPT_EXHAUSTED`. */
  readonly turns: readonly ScriptedTurn[];
  /** Every turn's usage. Absent: estimated from the request and the turn's text, as echo does. */
  readonly usage?: TokenUsage;
  /** What the gateway reports as `provider`, and keys its breaker by. Defaults to `scripted`. */
  readonly name?: string;
}

export interface ScriptedProvider extends Provider {
  /** Every request, in the order it arrived — a streamed one included. */
  readonly seen: readonly GenerateRequest[];
}

/**
 * More provider calls than scripted turns. Never answered by repeating the last turn: a loop that
 * never calls `respond` would then spin to its ceiling on a script that looks like it passed.
 */
export class AiScriptExhaustedError extends UltimateError {
  constructor(input: { turns: number; model: string }) {
    super({
      code: 'X_AI_SCRIPT_EXHAUSTED',
      cause:
        `scriptedProvider holds ${input.turns} turn${input.turns === 1 ? '' : 's'} and was ` +
        `asked for turn ${input.turns + 1} (model "${input.model}")`,
      fix: 'scriptedProvider({ turns: [...turns, { answer: { /* the expected output */ } }] })   # one more turn, or fix the loop that keeps calling the model',
      meta: { turns: input.turns },
    });
  }
}

/** The scripted test provider. Serves every registered model, read at call time. */
export function scriptedProvider(config: ScriptedProviderInput): ScriptedProvider {
  const seen: GenerateRequest[] = [];
  // `async`, so every refusal is a rejection — never a synchronous throw out of `generate()`.
  const generate = async (request: GenerateRequest): Promise<GenerateResult> => {
    // No model of its own, as echo: the gateway resolves before it routes.
    const model = resolveModel('scripted-provider', request.model);
    const turn = config.turns[seen.length];
    seen.push(request);
    if (turn === undefined) throw new AiScriptExhaustedError({ turns: config.turns.length, model });
    return resultOf(model, request, turn, seen.length, config.usage);
  };
  return {
    name: config.name ?? 'scripted',
    // A getter over the whole registry, not a snapshot: a model registered after construction.
    get models(): readonly ModelId[] {
      return modelIds();
    },
    seen,
    generate,
    // Not a generator: the turn is taken when `stream()` is CALLED, in call order with `generate()`.
    // A lazy one took it at the first read, so two calls in flight could swap their turns.
    stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
      const pending = generate(request);
      // Read or not, a refusal is not an unhandled rejection; a reader still gets the throw.
      pending.catch(() => undefined);
      return chunksOf(pending);
    },
  };
}

async function* chunksOf(pending: Promise<GenerateResult>): AsyncIterable<StreamChunk> {
  const result = await pending;
  if (result.text !== '') yield { type: 'text', text: result.text };
  for (const call of result.toolCalls) yield { type: 'tool-call', call };
  yield { type: 'done', result };
}

function callsOf(turn: ScriptedTurn, n: number): readonly LlmToolCall[] {
  if ('answer' in turn) return [{ id: `call-${n}`, name: RESPOND, input: turn.answer }];
  if ('call' in turn) return [{ id: `call-${n}`, name: turn.call, input: turn.input ?? {} }];
  if ('calls' in turn) {
    return turn.calls.map((one, i) => ({
      id: `call-${n}-${i + 1}`,
      name: one.call,
      input: one.input ?? {},
    }));
  }
  return [];
}

function resultOf(
  model: ModelId,
  request: GenerateRequest,
  turn: ScriptedTurn,
  n: number,
  fixed: TokenUsage | undefined,
): GenerateResult {
  const text = 'text' in turn ? turn.text : '';
  const toolCalls = callsOf(turn, n);
  const usage: TokenUsage = fixed ?? {
    inputTokens: estimateTokens({ ...request, model }),
    outputTokens: estimateTextTokens(text === '' ? JSON.stringify(toolCalls) : text),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  return {
    model,
    text,
    toolCalls,
    stopReason: turn.stop ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
    stopDetails: undefined,
    usage,
    cost: costOf(model, usage),
    costExact: exactCostOf(model, usage),
  };
}
