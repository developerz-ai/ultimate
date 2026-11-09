// Single responsibility: what one `llm()` call reports when it settles — the `ai.llm` event on
// core's instrumentation bus and the OpenTelemetry gen_ai usage on its span — on BOTH paths, a
// cache hit included. Split from ./llm at its line ceiling; the meter is the one place every
// provider call passes, so it is where the answering provider and model are read.

import type { Span } from '@ultimat3/core';
import { instrument, SEMCONV, subscribed } from '@ultimat3/core';
import type { GenerateResult } from './provider';
import type { RunMeter } from './run-meter';

/** What a cache hit, or a call no provider ever answered, reports as its provider. */
export const NO_PROVIDER = 'unknown';

export interface LlmReport {
  /** The run's meter, watched: hand THIS to every provider call so the answerer is seen. */
  readonly meter: RunMeter;
  /** Settle the call: usage onto the span, `ai.llm` onto the bus. Never throws of its own. */
  settle(outcome: { readonly cacheHit: boolean; readonly error?: unknown }): void;
}

/** Start reporting one `llm()` call, requested of `model`, under `span`. */
export function llmReport(span: Span, model: string, meter: RunMeter): LlmReport {
  const startedAt = performance.now();
  let provider = NO_PROVIDER;
  let answeredBy = model;
  const watched: RunMeter = {
    ...meter,
    call: async (work: Promise<GenerateResult>): Promise<GenerateResult> => {
      const result = await meter.call(work);
      provider = result.provider ?? NO_PROVIDER;
      answeredBy = result.model;
      return result;
    },
  };
  return {
    meter: watched,
    settle({ cacheHit, error }) {
      // The RUN's usage — every attempt, repair turns included — not the last answer's.
      const usage = meter.total()?.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      span.setAttributes({
        [SEMCONV.genAiProviderName]: provider,
        [SEMCONV.genAiResponseModel]: answeredBy,
        [SEMCONV.genAiUsageInputTokens]: inputTokens,
        [SEMCONV.genAiUsageOutputTokens]: outputTokens,
      });
      if (!subscribed('ai.llm')) return;
      instrument('ai.llm', {
        provider,
        model: answeredBy,
        inputTokens,
        outputTokens,
        cacheHit,
        durationMs: performance.now() - startedAt,
        ...(error === undefined ? {} : { error }),
      });
    },
  };
}

/**
 * ONE model call an `agent()` makes — a turn, or a compaction's summary — as `ai.llm`: the token
 * metric is per call, and an agent's spend would otherwise reach no subscriber. Emitted on both
 * paths; a failed call reports the model it ASKED for, no provider, and no tokens.
 */
export async function reportedCall(
  model: string,
  call: Promise<GenerateResult>,
): Promise<GenerateResult> {
  const startedAt = performance.now();
  let result: GenerateResult;
  try {
    result = await call;
  } catch (error) {
    if (subscribed('ai.llm')) {
      instrument('ai.llm', {
        provider: NO_PROVIDER,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheHit: false,
        durationMs: performance.now() - startedAt,
        error,
      });
    }
    throw error;
  }
  if (subscribed('ai.llm')) {
    instrument('ai.llm', {
      provider: result.provider ?? NO_PROVIDER,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheHit: false,
      durationMs: performance.now() - startedAt,
    });
  }
  return result;
}
