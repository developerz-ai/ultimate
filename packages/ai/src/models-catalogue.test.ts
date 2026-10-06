/**
 * The built-in Anthropic rows, each number against the page it was read from (As of 2026-10-06):
 * platform.claude.com/docs/en/models/overview, …/about-claude/pricing,
 * …/build-with-claude/{thinking,effort,prompt-caching}. A row that drifts from the vendor's page
 * prices, reserves and refuses wrong with no error anywhere, so the rows are pinned here whole.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { AiRequestInvalidError } from './errors';
import {
  ANTHROPIC_MODEL_IDS,
  DEFAULT_MODEL,
  modelSpec,
  moreCapableThan,
  reasoningBody,
  registerModel,
  resetModels,
} from './models';
import { registerOpenAiModels } from './openai-models';
import { AnthropicProvider, costOf, type TokenUsage } from './provider';

afterEach(() => {
  resetModels();
});

const usd = (minor: number) => ({ minor, currency: 'USD' });

/** id → [context, max output, $in/MTok minor, $out/MTok minor, cache minimum]. */
const PUBLISHED: Readonly<Record<string, readonly [number, number, number, number, number]>> = {
  'claude-fable-5-1': [1_000_000, 128_000, 1_000, 5_000, 512],
  'claude-opus-5-5': [1_000_000, 128_000, 400, 2_000, 512],
  'claude-opus-5': [1_000_000, 128_000, 500, 2_500, 512],
  'claude-sonnet-5-5': [1_000_000, 128_000, 200, 1_000, 512],
  // $2/$10 became Sonnet 5's STANDARD price; the $3/$15 step-up on 2026-09-01 was cancelled.
  'claude-sonnet-5': [1_000_000, 128_000, 200, 1_000, 1_024],
  'claude-haiku-4-5': [200_000, 64_000, 100, 500, 4_096],
};

describe('the built-in Anthropic rows match the published specs', () => {
  test('the provider serves exactly the published rows, most capable first', () => {
    expect([...ANTHROPIC_MODEL_IDS]).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    expect(new AnthropicProvider().models).toEqual(ANTHROPIC_MODEL_IDS);
  });

  test('context, output ceiling, list prices and cache minimum, row by row', () => {
    for (const [id, [context, output, input, out, cache]] of Object.entries(PUBLISHED)) {
      const spec = modelSpec(id);
      expect([id, spec.contextWindow, spec.maxOutput, spec.cacheMinimumTokens]).toEqual([
        id,
        context,
        output,
        cache,
      ]);
      expect([id, spec.inputPerMillion, spec.outputPerMillion]).toEqual([id, usd(input), usd(out)]);
      expect(spec.family).toBe('anthropic');
    }
  });

  // A behaviour change, decided for a major: the default stays where 24.x shipped it.
  test('the default model is unchanged by the new rows', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-5');
  });

  // The refusal fix line points UP; a newer model above the default is now a real answer for it.
  test('a refusal on the default model is pointed at the newer Opus, and the top has no answer', () => {
    expect(moreCapableThan('claude-opus-5')).toBe('claude-opus-5-5');
    expect(moreCapableThan('claude-opus-5-5')).toBe('claude-fable-5-1');
    expect(moreCapableThan('claude-fable-5-1')).toBeUndefined();
  });
});

describe('the thinking rule each new model enforces', () => {
  // "Claude Fable 5.1 … Claude Opus 5.5 … reject thinking: {type: "disabled"}. Thinking can't be
  // turned off on these models" — a 400 at EVERY effort, so it is refused here at every effort.
  test('Opus 5.5 and Fable 5.1 refuse thinking: disabled at every effort, naming the knob', () => {
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
      for (const effort of [undefined, 'low', 'high', 'max'] as const) {
        try {
          reasoningBody(model, effort, 'disabled');
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(AiRequestInvalidError);
          expect((error as AiRequestInvalidError).cause).toContain(model);
          expect((error as AiRequestInvalidError).fix).toContain('effort');
        }
      }
    }
  });

  test('Opus 5.5 and Fable 5.1 still take every effort rung and an explicit adaptive block', () => {
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
      expect(reasoningBody(model, 'max', 'adaptive')).toEqual({
        output_config: { effort: 'max' },
        thinking: { type: 'adaptive', display: 'summarized' },
      });
      expect(reasoningBody(model, 'xhigh', undefined)).toEqual({
        output_config: { effort: 'xhigh' },
      });
    }
  });

  // Sonnet 5.5 400s on `disabled` and spells "no up-front thinking" `between_tools`, legal only at
  // `high` or below — the framework's `thinking: 'disabled'` is that request on this model.
  test("Sonnet 5.5 sends between_tools for thinking: 'disabled', and only at high or below", () => {
    expect(reasoningBody('claude-sonnet-5-5', 'high', 'disabled')).toEqual({
      output_config: { effort: 'high' },
      thinking: { type: 'between_tools' },
    });
    expect(reasoningBody('claude-sonnet-5-5', undefined, 'disabled')['thinking']).toEqual({
      type: 'between_tools',
    });
    expect(() => reasoningBody('claude-sonnet-5-5', 'xhigh', 'disabled')).toThrow(
      AiRequestInvalidError,
    );
  });

  test('the older rows keep their own rules', () => {
    expect(reasoningBody('claude-opus-5', 'high', 'disabled')['thinking']).toEqual({
      type: 'disabled',
    });
    expect(() => reasoningBody('claude-opus-5', 'max', 'disabled')).toThrow(AiRequestInvalidError);
    expect(reasoningBody('claude-sonnet-5', 'max', 'disabled')['thinking']).toEqual({
      type: 'disabled',
    });
  });
});

/**
 * `costOf` per row, against sums worked by hand from the pricing page's per-MTok columns (base
 * input, 5m cache write, cache hits, output). One million of each, so each term is the list price.
 */
describe("costOf prices cache reads and writes at each row's published rate", () => {
  const MTOK: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };
  const ONLY = (field: keyof TokenUsage, tokens = 1_000_000): TokenUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    [field]: tokens,
  });

  test('every Anthropic row: input + 5m write + cache hit + output', () => {
    const expected: Readonly<Record<string, number>> = {
      'claude-fable-5-1': 1_000 + 1_250 + 25 + 5_000, // $10 + $12.50 + $0.25 + $50
      'claude-opus-5-5': 400 + 500 + 20 + 2_000, // $4 + $5 + $0.20 + $20
      'claude-opus-5': 500 + 625 + 50 + 2_500, // $5 + $6.25 + $0.50 + $25
      'claude-sonnet-5-5': 200 + 250 + 20 + 1_000, // $2 + $2.50 + $0.20 + $10
      'claude-sonnet-5': 200 + 250 + 20 + 1_000,
      'claude-haiku-4-5': 100 + 125 + 10 + 500, // $1 + $1.25 + $0.10 + $5
    };
    for (const [id, minor] of Object.entries(expected)) {
      expect([id, costOf(id, MTOK)]).toEqual([id, usd(minor)]);
    }
  });

  // The bug this closes: a flat 0.1x read charged Opus 5.5 twice and Fable 5.1 four times over.
  test('the two discounted cache-hit rates, and rounding UP on a single token', () => {
    expect(costOf('claude-opus-5-5', ONLY('cacheReadTokens'))).toEqual(usd(20));
    expect(costOf('claude-fable-5-1', ONLY('cacheReadTokens'))).toEqual(usd(25));
    expect(costOf('claude-fable-5-1', ONLY('cacheReadTokens', 1))).toEqual(usd(1));
  });

  test('the OpenAI-format rows read cached input at their own published rate', () => {
    registerOpenAiModels();
    expect(costOf('gpt-5.6-sol', ONLY('cacheReadTokens'))).toEqual(usd(50));
    expect(costOf('gpt-5.6-terra', ONLY('cacheReadTokens'))).toEqual(usd(20));
    expect(costOf('gpt-5.6-luna', ONLY('cacheReadTokens'))).toEqual(usd(2));
  });

  test('a custom row with no cache rates keeps the 0.1x read and 1.25x write defaults', () => {
    const {
      cacheReadPerMillion: _r,
      cacheWritePerMillion: _w,
      ...spec
    } = modelSpec('claude-opus-5');
    registerModel({ ...spec, id: 'acme-25', inputPerMillion: usd(25) });
    expect(costOf('acme-25', ONLY('cacheReadTokens'))).toEqual(usd(3)); // 2.5, rounded up
    expect(costOf('acme-25', ONLY('cacheWriteTokens'))).toEqual(usd(32)); // 31.25, rounded up
    expect(costOf('acme-25', { ...ONLY('cacheReadTokens'), cacheWriteTokens: 1_000_000 })).toEqual(
      usd(34), // 33.75, rounded up once over the sum
    );
  });
});
