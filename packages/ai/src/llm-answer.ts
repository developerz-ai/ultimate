// Single responsibility: what one answered `llm()` turn amounts to — its span attributes, its
// `onCall` report, whether a value fits the declared `output`, and the one streamed turn's answer
// under the same rules. Split from ./llm at its line ceiling.

import type { Span, SpanAttributes } from '@ultimat3/core';
import { SEMCONV } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import { formatIssues, validateAsync } from '@ultimat3/schema';
import { runTotal } from './agent-usage';
import { LlmTruncatedError } from './answer-errors';
import { LlmRefusedError, LlmStreamInvalidError } from './errors';
import type { Gateway } from './gateway';
import type { LlmDef } from './llm-def';
import type { LlmSink } from './llm-stream';
import { streamOneTurn } from './llm-stream';
import { moreCapableThan } from './models';
import type { PromptVars } from './prompt';
import type { GenerateRequest, GenerateResult } from './provider';
import { isTruncated } from './provider';
import { parseJsonish } from './respond';
import type { RunMeter } from './run-meter';

/**
 * What one answered turn puts on the span. The provider that answered is the half the LLM-gateway
 * table called "a fallback is recorded in the span, never silent": fallback in this framework is
 * across PROVIDERS serving one model, never across models, and until the gateway stamped the
 * provider that answered, a fallback was exactly as silent as no fallback at all. It lands as
 * semconv's `gen_ai.provider.name`, with the token usage, when the call settles (`llm-instrument.ts`).
 */
export function answerAttributes(result: GenerateResult): SpanAttributes {
  return {
    'ultimate.llm.stop': result.stopReason,
    'ultimate.llm.cost.minor': result.cost.minor,
    [SEMCONV.genAiProviderName]: result.provider ?? 'unknown',
    [SEMCONV.genAiResponseModel]: result.model,
  };
}

/**
 * One streamed turn, from the same declaration and under the same rules — with one difference
 * that is forced rather than chosen: no repair turn. The tokens are already on the consumer's
 * screen, so a second answer would be two answers to one question; a stream gets one attempt and
 * `X_LLM_STREAM_INVALID` names the non-streaming call as the fix.
 *
 * The stop reason is still read BEFORE the answer, for the reason it always was: a refusal
 * carries empty or partial content and parsing it first reports a schema disagreement that is not
 * one. Truncation is the same call it is on the non-streaming path.
 */
export async function streamedAnswer<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(
  def: LlmDef<TInput, TOutput, V>,
  name: string,
  gateway: Gateway,
  request: GenerateRequest,
  sink: LlmSink,
  span: Span,
  meter: RunMeter,
): Promise<InferOutput<TOutput>> {
  const { output } = def;
  const result = await meter.call(streamOneTurn(gateway, request, sink));
  span.setAttributes({ 'ultimate.llm.attempts': 1, ...answerAttributes(result) });
  await observeCall(def, meter, result, 1, undefined);
  if (result.stopReason === 'refusal') {
    throw new LlmRefusedError({
      prompt: name,
      model: result.model,
      alternative: moreCapableThan(result.model, request),
      category: result.stopDetails?.category,
      explanation: result.stopDetails?.explanation,
    });
  }
  if (isTruncated(result.stopReason)) {
    throw new LlmTruncatedError({ prompt: name, maxTokens: request.maxTokens });
  }
  // Prose, and its JSON parse when it has one. Both, because a stream carries no `respond` tool
  // to tell them apart: `output: t.string` is satisfied by the text itself, and an object schema
  // by what the text parses to — trying only one of the two makes a legal declaration unusable.
  const parsed = await accept(output, parseJsonish(result.text));
  if (parsed !== undefined) return parsed.value;
  const fallback = await validateAsync(output, result.text);
  if (fallback.issues === undefined) return fallback.value;
  throw new LlmStreamInvalidError({
    prompt: name,
    issues: formatIssues(fallback.issues).join('; '),
  });
}

/** One provider call, reported to the declaration's `onCall`. Awaited; a throw fails the call. */
export async function observeCall<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(
  def: LlmDef<TInput, TOutput, V>,
  meter: RunMeter,
  result: GenerateResult,
  attempt: number,
  repairOf: readonly string[] | undefined,
): Promise<void> {
  if (def.onCall === undefined) return;
  await def.onCall({
    attempt,
    model: result.model,
    provider: result.provider,
    stopReason: result.stopReason,
    usage: result.usage,
    cost: result.cost,
    ...(result.costExact === undefined ? {} : { costExact: result.costExact }),
    ...(repairOf === undefined ? {} : { repairOf }),
    run: runTotal(result.model, undefined, meter.total()),
  });
}

/** `undefined` for "does not fit". Wrapped so a legitimately falsy value is still a hit. */
export async function accept<TOutput extends StandardSchemaV1>(
  schema: TOutput,
  value: unknown,
): Promise<{ readonly value: InferOutput<TOutput> } | undefined> {
  if (value === undefined) return undefined;
  const parsed = await validateAsync(schema, value);
  return parsed.issues === undefined ? { value: parsed.value } : undefined;
}
