// The OpenAI-format built-in catalogue: the vendor's own list prices, registered through the same
// public `registerModel` the Anthropic built-ins use. Here rather than in models.ts because these
// rows belong to a PROVIDER — models.ts owns the registry mechanism, never one vendor's price list.

import type { Money } from '@ultimat3/money';
import type { ModelId } from './models';
import { registerModel } from './models';

/** A price per million tokens, in INTEGER MINOR UNITS. Same rule as models.ts: never a float. */
const usd = (minor: number): Money => ({ minor, currency: 'USD' });

/**
 * The ids this package prices, in ladder order (most capable first). A provider's `models` list is
 * still its own — an endpoint speaking this format serves whatever ids it was deployed with, and
 * `openAiProvider({ models })` is where those are named.
 */
export const OPENAI_MODEL_IDS: readonly ModelId[] = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
];

/**
 * Shared by the whole 5.6 family: a 1.05M context, a 128k output ceiling, and `reasoning_effort`
 * over exactly the five rungs `EFFORTS` declares (the endpoint also takes `none`, which is what
 * `thinking: 'disabled'` maps onto). `adaptive` is false because the format has no
 * adaptive-thinking control at all — depth is `reasoning_effort` and nothing else.
 */
const FAMILY = {
  /** One ladder: `moreCapableThan` compares these three with each other and with nothing else. */
  family: 'openai',
  contextWindow: 1_050_000,
  maxOutput: 128_000,
  /** Automatic caching starts at a 1024-token prefix; a shorter one silently does not cache. */
  cacheMinimumTokens: 1_024,
  reasoning: { effort: true, adaptive: false, disableThinkingUpTo: undefined },
} as const;

/**
 * The three models this package is confident enough to price, and no more.
 *
 * Prices are the vendor's published list, read from developers.openai.com/api/docs/pricing on
 * **2026-08-16**, in USD per million tokens:
 *
 * | id | input | cached input | output |
 * |---|---|---|---|
 * | `gpt-5.6-sol` | $5.00 | $0.50 | $30.00 |
 * | `gpt-5.6-terra` | $2.00 | $0.20 | $12.00 |
 * | `gpt-5.6-luna` | $0.20 | $0.02 | $1.20 |
 *
 * Deliberately not registered: `gpt-4o`, `gpt-4o-mini` and the `o1` family, whose cached input is
 * **0.5x** their input rate rather than the 0.1x `costOf` assumes — a spec that prices them would
 * under-report a cache-heavy workload by four fifths, and `costOf` answers confidently either way.
 * `gpt-5.5-pro` and `o1-pro` are out for the same class of reason: they publish no cached rate.
 * A wrong price is worse than no entry, so an app wanting one of those registers it itself, with
 * the rate its own contract names.
 */
export function registerOpenAiModels(): void {
  registerModel({
    id: 'gpt-5.6-sol',
    ...FAMILY,
    inputPerMillion: usd(500),
    outputPerMillion: usd(3_000),
  });
  registerModel({
    id: 'gpt-5.6-terra',
    ...FAMILY,
    inputPerMillion: usd(200),
    outputPerMillion: usd(1_200),
  });
  registerModel({
    id: 'gpt-5.6-luna',
    ...FAMILY,
    inputPerMillion: usd(20),
    outputPerMillion: usd(120),
  });
}

// The same shape models.ts uses for its built-ins: registration is a module side effect, so the
// default path is the app's path and importing the provider is enough to price what it serves.
// Exported as well as called, because the registry is module state and a suite that clears it with
// `resetModels()` otherwise leaves this provider serving ids nothing can price. Re-registering
// REPLACES, so an app with a negotiated rate calls `registerModel` after this one and wins.
registerOpenAiModels();
