/**
 * Every model Postly calls, registered by Postly. Apps bring their own models and providers: the
 * framework registers none and chooses none (`@ultimat3/ai` 25.0.0), so a model this app names is a
 * row this app wrote, with its own numbers and its own source — and an id it never registered is
 * `X_AI_MODEL_UNKNOWN` at the first call.
 *
 * Each id is EXPORTED from here and spelled nowhere else — a prompt or an agent names a model by
 * importing it, so naming one and registering it are the same import, and an id this file does not
 * hold is one the app has no way to write. `models.test.ts` holds every declaration to it.
 */

import { registerModel } from '@ultimat3/ai';

/** Integer minor units, always with the currency: a token price is money like any other. */
const usd = (minor: number) => ({ minor, currency: 'USD' }) as const;

/**
 * Claude Sonnet 5 — `summarize` and `reviewDraft`. Read 2026-10-06 from the vendor's pages:
 * https://platform.claude.com/docs/en/about-claude/pricing — $2 / $10 per MTok in and out (the
 * launch price, now standard), $2.50 for a 5-minute cache write, $0.20 for a cache hit;
 * https://platform.claude.com/docs/en/models/sonnet-5/overview — 1M context, 128K output, adaptive
 * thinking that may be switched off at any effort; 1,024 tokens is its minimum cacheable prefix
 * (https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
 *
 * A LEGACY model on the overview page as of that date (Sonnet 5.5 is current). Moving off it is a
 * new row here and a new prompt version, because the model is part of what a baseline measured.
 */
export const claudeSonnet5 = registerModel({
  id: 'claude-sonnet-5',
  // The vendor's ladder, so `X_LLM_REFUSED`'s "a more capable model" walks Claude rungs only.
  family: 'anthropic',
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  inputPerMillion: usd(200),
  outputPerMillion: usd(1_000),
  cacheReadPerMillion: usd(20),
  cacheWritePerMillion: usd(250),
  cacheMinimumTokens: 1_024,
  input: ['image', 'document'],
  reasoning: { effort: true, adaptive: true, disableThinkingUpTo: undefined },
});

export const CLAUDE_SONNET_5 = claudeSonnet5.id;

/** Every row above, for the test that holds each declaration to this file. */
export const APP_MODELS = [claudeSonnet5] as const;
