// The blessed models: their limits, their prices, and the reasoning controls each one's request
// surface actually accepts.
//
// The last of those is the reason this file exists apart from ./provider. The controls are NOT
// uniform across the catalogue — `output_config.effort` and adaptive thinking arrived with 4.6 —
// so one body sent to all three models is a guaranteed 400 on the oldest one. A downgrade for
// price is a price decision, not a licence to send a body the provider rejects.
//
// Prices are in INTEGER MINOR UNITS per million tokens. Token spend is money, and the house rule
// applies to money regardless of where it comes from: never a float.
//
// As of 2026-08. Model IDs are exact alias strings — never append a date suffix.

import type { Money } from '@ultimat3/money';
import { AiRequestInvalidError } from './errors';

/** Blessed models. Opus 5 is the default; the others are explicit downgrades. */
export const MODEL_IDS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const DEFAULT_MODEL: ModelId = 'claude-opus-5';

/**
 * Reasoning depth, shallowest first — the order is load-bearing, because a model that caps where
 * thinking may be switched off compares against it. `xhigh` is the best setting for coding and
 * agentic work; `high` is the API default. Distinct from `maxTokens`, which is an enforced
 * ceiling the model cannot see.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Thinking mode. Adaptive lets the model decide depth per request and is the default on every
 * model that has it. There is no token budget to tune — `effort` replaced it.
 */
export type ThinkingMode = 'adaptive' | 'disabled';

/**
 * What one model's request surface accepts. Every field here is a 400 when it is sent to a model
 * that does not take it, which is why it is data on the spec rather than a rule in the request
 * builder: adding a fourth model is a row, not an `if`.
 */
export interface ModelReasoning {
  /** `output_config.effort`. Models older than 4.6 reject it outright. */
  readonly effort: boolean;
  /** `thinking: {type:'adaptive'}`. Older models take a token budget this package never sends. */
  readonly adaptive: boolean;
  /** Deepest effort that still accepts `thinking: 'disabled'`; `undefined` = every effort does. */
  readonly disableThinkingUpTo: Effort | undefined;
}

export interface ModelSpec {
  readonly id: ModelId;
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** Cost of one million input tokens, in minor units. */
  readonly inputPerMillion: Money;
  /** Cost of one million output tokens, in minor units. */
  readonly outputPerMillion: Money;
  /** Minimum cacheable prefix; a shorter prefix silently does not cache. */
  readonly cacheMinimumTokens: number;
  readonly reasoning: ModelReasoning;
}

const usd = (minor: number): Money => ({ minor, currency: 'USD' });

export const MODELS: Readonly<Record<ModelId, ModelSpec>> = {
  // $5 / $25 per MTok.
  'claude-opus-5': {
    id: 'claude-opus-5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    inputPerMillion: usd(500),
    outputPerMillion: usd(2_500),
    cacheMinimumTokens: 512,
    // Thinking is on by default here, and switching it OFF is legal only at `high` or below.
    reasoning: { effort: true, adaptive: true, disableThinkingUpTo: 'high' },
  },
  // $3 / $15 per MTok. The introductory rate is deliberately NOT modelled: a price that lapses on
  // a date makes every recorded cost depend on when it was read, and a budget that under-reports
  // spend after the lapse is a budget that is not one. List price over-reserves, which is safe.
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    inputPerMillion: usd(300),
    outputPerMillion: usd(1_500),
    cacheMinimumTokens: 1_024,
    reasoning: { effort: true, adaptive: true, disableThinkingUpTo: undefined },
  },
  // $1 / $5 per MTok. Pre-4.6, so it has neither knob: an `output_config.effort` or an adaptive
  // `thinking` block sent here is a 400 on every request, which is what made the cheap tier
  // uncallable while the request body was one shape for the whole catalogue.
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    contextWindow: 200_000,
    maxOutput: 64_000,
    inputPerMillion: usd(100),
    outputPerMillion: usd(500),
    cacheMinimumTokens: 4_096,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  },
};

const rankOf = (effort: Effort): number => EFFORTS.indexOf(effort);

/**
 * The reasoning half of a Messages body, shaped for one model. Everything it refuses, it refuses
 * LOCALLY with a real code — a round trip to learn a rule this file already states costs latency
 * and teaches nothing, and the provider's own message names the field rather than the fix.
 *
 * A control the caller never asked for is OMITTED rather than defaulted, so a model without the
 * knob stays callable. A control the caller did ask for is never silently dropped: a declaration
 * that reads `effort: 'max'` and quietly runs at the default is the failure nobody can see.
 */
export function reasoningBody(
  model: ModelId,
  effort: Effort | undefined,
  thinking: ThinkingMode | undefined,
): Record<string, unknown> {
  const rules = MODELS[model].reasoning;
  const body: Record<string, unknown> = {};

  if (rules.effort) {
    // `output_config`, not a top-level `effort` — a top-level one is silently ignored.
    body['output_config'] = { effort: effort ?? 'high' };
  } else if (effort !== undefined) {
    throw new AiRequestInvalidError({
      detail: `model "${model}" has no effort control; output_config.effort is a 400 on it`,
      fix: `drop effort from the prompt, or set model: '${DEFAULT_MODEL}' on the declaration`,
    });
  }

  if (!rules.adaptive) {
    if (thinking === 'adaptive') {
      throw new AiRequestInvalidError({
        detail: `model "${model}" predates adaptive thinking; a thinking block is a 400 on it`,
        fix: `set model: '${DEFAULT_MODEL}' on the declaration, or drop thinking from the prompt`,
      });
    }
    // No `thinking` field at all is exactly "no thinking" on a pre-4.6 model, so `disabled`
    // needs nothing sent — and sending a block it may not parse would be a 400 for no gain.
    return body;
  }

  if ((thinking ?? 'adaptive') === 'disabled') {
    assertDisableAllowed(model, rules, effort ?? 'high');
    body['thinking'] = { type: 'disabled' };
    return body;
  }
  body['thinking'] = { type: 'adaptive', display: 'summarized' };
  return body;
}

/** Some models cap the effort at which thinking may be switched off. Above the cap it is a 400. */
function assertDisableAllowed(model: ModelId, rules: ModelReasoning, effort: Effort): void {
  const cap = rules.disableThinkingUpTo;
  if (cap === undefined || rankOf(effort) <= rankOf(cap)) return;
  throw new AiRequestInvalidError({
    detail: `model "${model}" allows thinking: 'disabled' only at effort '${cap}' or below, not '${effort}'`,
    fix: `set effort: '${cap}' on the prompt alongside thinking: 'disabled', or leave thinking adaptive`,
  });
}
