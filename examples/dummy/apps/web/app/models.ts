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
 * Claude Sonnet 5.5 — `summarize` (v6) and `reviewDraft` (v2). Read 2026-11-03 from the vendor's
 * pages: https://platform.claude.com/docs/en/about-claude/pricing — $2 / $10 per MTok in and out,
 * $2.50 for a 5-minute cache write, $0.10 for a cache hit (0.05x the input price on this model);
 * https://platform.claude.com/docs/en/about-claude/models/overview — 1M context, 128K output,
 * adaptive thinking; the Models API reports `thinking.types.disabled` unsupported and
 * `between_tools` supported, so "thinking off" is sent as `between_tools` (refused above `high`, as
 * `@ultimat3/ai`'s `model-rules.test.ts` records); 512 tokens is its
 * minimum cacheable prefix (https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
 *
 * `forcedToolChoice: false`: with thinking on it refuses a forced tool choice (measured through
 * OpenRouter 2026-10-11, `wiki/Agents.md`), so `llm()`'s one `respond` tool is offered unforced.
 * No `sampling`: the row sends neither `temperature` nor `seed`.
 */
export const claudeSonnet55 = registerModel({
  id: 'claude-sonnet-5-5',
  // The vendor's ladder, so `X_LLM_REFUSED`'s "a more capable model" walks Claude rungs only.
  family: 'anthropic',
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  inputPerMillion: usd(200),
  outputPerMillion: usd(1_000),
  cacheReadPerMillion: usd(10),
  cacheWritePerMillion: usd(250),
  cacheMinimumTokens: 512,
  input: ['image', 'document'],
  reasoning: {
    effort: true,
    adaptive: true,
    disableThinkingUpTo: 'high',
    disabledThinking: 'between_tools',
  },
  forcedToolChoice: false,
});

export const CLAUDE_SONNET_5_5 = claudeSonnet55.id;

/**
 * Claude Sonnet 5 — what `summarize` v5 and `reviewDraft` v1 ran on, so the retained artifacts and
 * baselines of those versions still name a row this app holds. Read 2026-10-06:
 * https://platform.claude.com/docs/en/about-claude/pricing — $2 / $10 per MTok, $2.50 for a
 * 5-minute cache write, $0.20 for a cache hit; 1M context, 128K output; 1,024 tokens is its minimum
 * cacheable prefix. LEGACY on the overview page; registered after Sonnet 5.5 so the ladder reads
 * the newer row as the more capable one. No prompt names it any more.
 */
export const claudeSonnet5 = registerModel({
  id: 'claude-sonnet-5',
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
export const APP_MODELS = [claudeSonnet55, claudeSonnet5] as const;
