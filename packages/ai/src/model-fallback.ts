// Single responsibility: `fallbackModels` — which failures a model chain falls over on (the declared
// class), the chain's screen, and the loop that walks it for one `generate` or one stream: an attempt
// span per model under the caller's one span, and every failed attempt stamped onto the answer.

import type { Span } from '@ultimat3/core';
import {
  asyncContext,
  isUltimateError,
  renderThrowable,
  SEMCONV,
  startSpan,
  stringField,
  withSpan,
} from '@ultimat3/core';
import type { Billed } from './billed';
import { billedOf } from './billed';
import { AiProviderUnavailableError, AiRequestInvalidError } from './errors';
import type { ModelId } from './models';
import { modelSpec } from './models';
import type { GenerateResult, StreamChunk } from './provider';

/**
 * The DECLARED classes a chain falls over on — every one a fact about the model's hosts at this
 * moment, never about the request: the same request has a real chance on the next model.
 *
 * | Class | Read from |
 * |---|---|
 * | `rate_limited` | 429 |
 * | `overloaded` | 529 |
 * | `timeout` | 408, 504, `ETIMEDOUT` |
 * | `unavailable` | any other 5xx, a refused/dropped/unopenable socket, every breaker open |
 *
 * Never: a 4xx (the request), a refusal or truncation (an answer), a budget, an abort, a model no
 * provider lists (`app.config.ts`) — each would fail, or be wrong, the same way on every model.
 */
export const MODEL_FALLBACK_ON = ['rate_limited', 'overloaded', 'timeout', 'unavailable'] as const;

export type ModelFallbackClass = (typeof MODEL_FALLBACK_ON)[number];

/** One model of a chain that failed before the next was asked. */
export interface ModelFallback {
  readonly model: ModelId;
  readonly reason: ModelFallbackClass;
  /** The failure, rendered (`renderThrowable`): bounded, and never a provider's whole body. */
  readonly cause: string;
  /** What it was billed, when its failure carried a bill; absent means unsettled, never free. */
  readonly billed?: Billed;
}

const PROVIDER_UNAVAILABLE = 'X_AI_PROVIDER_UNAVAILABLE';
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
]);

/**
 * The class of ONE transport failure, read off `status` / `code` — total: the value came from an
 * app's `Provider`, and a property read on it can trap. 409 and 425 are retryable on the same
 * host but say nothing about the model, so they are no class.
 */
export function transportFallbackClass(error: unknown): ModelFallbackClass | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const { status, code } = error as { status?: unknown; code?: unknown };
    if (typeof status === 'number') {
      if (status === 429) return 'rate_limited';
      if (status === 529) return 'overloaded';
      if (status === 408 || status === 504) return 'timeout';
      return status >= 500 ? 'unavailable' : undefined;
    }
    if (code === 'ETIMEDOUT') return 'timeout';
    return typeof code === 'string' && UNAVAILABLE_CODES.has(code) ? 'unavailable' : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a model's failure falls over, and as what. The gateway's own exhausted error carries the
 * verdict its retry loop reached (`fallback`); any other coded refusal never falls over; a raw
 * provider throw (a stream's first pull) is classed by its transport fields.
 */
export function fallbackClassOf(error: unknown): ModelFallbackClass | undefined {
  if (error instanceof AiProviderUnavailableError) return error.fallback;
  if (isUltimateError(error) && stringField(error, 'code') !== PROVIDER_UNAVAILABLE) {
    return undefined;
  }
  return transportFallbackClass(error);
}

/**
 * The chain, screened before a reservation or a socket: every id registered (`X_AI_MODEL_UNKNOWN`)
 * and none twice — a repeated model is a second bill for the answer that just failed.
 */
export function modelChain(
  model: ModelId,
  fallbackModels: readonly ModelId[] | undefined,
): readonly ModelId[] {
  const chain = [model, ...(fallbackModels ?? [])];
  for (const [index, id] of chain.entries()) {
    modelSpec(id);
    if (chain.indexOf(id) !== index) {
      throw new AiRequestInvalidError({
        detail: `fallbackModels names "${id}" twice in the chain ${chain.join(' → ')}; a repeat asks a model that just failed`,
        fix: `fallbackModels: [${chain
          .filter((one, at) => chain.indexOf(one) === at && one !== model)
          .map((one) => `'${one}'`)
          .join(', ')}]   # each model once, the primary not among them`,
      });
    }
  }
  return chain;
}

/**
 * What a DECLARATION's chain adds to a request on `model`: the chain without `model` itself — a
 * run's own pick (`agent()`'s `model()`, `llm()`'s resolution) may be one of its fallbacks, and is
 * then simply not asked twice. Nothing when no fallback is left.
 */
export function declaredFallbacks(
  model: ModelId,
  fallbackModels: readonly ModelId[] | undefined,
): { readonly fallbackModels?: readonly ModelId[] } {
  const rest = (fallbackModels ?? []).filter((one) => one !== model);
  return rest.length === 0 ? {} : { fallbackModels: rest };
}

const fellOverAs = (model: ModelId, reason: ModelFallbackClass, error: unknown): ModelFallback => {
  const billed = billedOf(error);
  return {
    model,
    reason,
    cause: renderThrowable(error),
    ...(billed === undefined ? {} : { billed }),
  };
};

/** Every model failed on a declared class: one coded error naming each, for the meter to count. */
const exhausted = (chain: readonly ModelId[], fellOver: readonly ModelFallback[]): unknown =>
  new AiProviderUnavailableError({
    model: chain.join(' → '),
    attempts: fellOver.map((one) => `${one.model}: ${one.reason}`),
    fellOver,
  });

const attemptAttributes = (model: ModelId, index: number) => ({
  [SEMCONV.genAiRequestModel]: model,
  'ultimate.llm.fallback.index': index,
});

/**
 * Where a chain reports each model it falls over FROM, the moment it moves on: the run meter of the
 * call in flight (`RunMeter.call` opens one around the call). Ambient per CALL, never keyed on a
 * thrown value — one object can reject two calls at once (`signal.reason`), and an attempt read off
 * it was credited to whichever meter caught it first. The model that ends the walk is the call's
 * own throw or answer, which the meter counts already.
 */
const attemptSinks = asyncContext<(attempt: ModelFallback) => void>(
  'a model-fallback attempt sink',
);

/** Run `work` with `sink` hearing every model a chain inside it falls over from. */
export function withAttemptSink<T>(sink: (attempt: ModelFallback) => void, work: () => T): T {
  return attemptSinks.run(sink, work);
}

/** The model failed declared: kept for the answer, reported unless it was the chain's last. */
function fallOver(
  fellOver: ModelFallback[],
  attempt: ModelFallback,
  last: boolean,
  chain: readonly ModelId[],
): void {
  fellOver.push(attempt);
  if (last) throw exhausted(chain, fellOver);
  attemptSinks.get()?.(attempt);
}

/**
 * One `generate` over the chain. A single-model chain is the call itself — no span, nothing stamped.
 * Otherwise each model runs in its own `ai.model.attempt` span; a failure outside the declared
 * class, or the last model's, ends the walk.
 */
export async function generateOverModels(
  chain: readonly ModelId[],
  run: (model: ModelId, index: number) => Promise<GenerateResult>,
): Promise<GenerateResult> {
  const [only] = chain;
  if (chain.length === 1 && only !== undefined) return run(only, 0);
  const fellOver: ModelFallback[] = [];
  for (const [index, model] of chain.entries()) {
    try {
      const result = await withSpan('ai.model.attempt', (span) => {
        span.setAttributes(attemptAttributes(model, index));
        return run(model, index).catch((error: unknown) => {
          markReason(span, error);
          throw error;
        });
      });
      return fellOver.length === 0 ? result : { ...result, fallbacks: fellOver };
    } catch (error) {
      const reason = fallbackClassOf(error);
      if (reason === undefined) throw error;
      fallOver(fellOver, fellOverAs(model, reason, error), index === chain.length - 1, chain);
    }
  }
  throw exhausted(chain, fellOver);
}

const markReason = (span: Span, error: unknown): void => {
  const reason = fallbackClassOf(error);
  if (reason !== undefined) span.setAttribute('ultimate.llm.fallback.reason', reason);
};

/**
 * One stream over the chain. Falls over ONLY before the first chunk reaches the consumer: from then
 * on a replay would duplicate what it already read, so a later failure is thrown as it stands. Nor
 * once `spent()` says the call's time budget is gone — the same rule `generate`'s retry loop keeps.
 */
export async function* streamOverModels(
  chain: readonly ModelId[],
  run: (model: ModelId) => AsyncIterable<StreamChunk>,
  spent: () => boolean = () => false,
): AsyncIterable<StreamChunk> {
  const [only] = chain;
  if (chain.length === 1 && only !== undefined) {
    yield* run(only);
    return;
  }
  const fellOver: ModelFallback[] = [];
  for (const [index, model] of chain.entries()) {
    const span = startSpan('ai.model.attempt', { attributes: attemptAttributes(model, index) });
    let delivered = false;
    try {
      for await (const chunk of run(model)) {
        delivered = true;
        yield chunk.type === 'done' && fellOver.length > 0
          ? { type: 'done', result: { ...chunk.result, fallbacks: [...fellOver] } }
          : chunk;
      }
      return;
    } catch (error) {
      span.recordError(error);
      const last = index === chain.length - 1;
      const reason = delivered || (!last && spent()) ? undefined : fallbackClassOf(error);
      if (reason === undefined) throw error;
      span.setAttribute('ultimate.llm.fallback.reason', reason);
      fallOver(fellOver, fellOverAs(model, reason, error), last, chain);
    } finally {
      span.end();
    }
  }
}
