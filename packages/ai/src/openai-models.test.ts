/**
 * The catalogue rows. A price is not decoration — `costOf` answers from it confidently, the budget
 * reserves against it, and every recorded cost is it. So the numbers are pinned, and so is the
 * DELIBERATE absence of the models this package would have had to guess at.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { ANTHROPIC_MODEL_IDS, modelIds, modelSpec, moreCapableThan, registerModel } from './models';
import { OPENAI_MODEL_IDS, registerOpenAiModels } from './openai-models';
import { costOf } from './provider';

const MTOK = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

beforeEach(() => {
  registerOpenAiModels();
});

describe('the built-in OpenAI-format models', () => {
  test('carry the published list price, in integer minor units', () => {
    // developers.openai.com/api/docs/pricing, read 2026-08-16: $5 / $30, $2 / $12, $0.20 / $1.20.
    expect(costOf('gpt-5.6-sol', MTOK)).toEqual({ minor: 500, currency: 'USD' });
    expect(costOf('gpt-5.6-terra', MTOK)).toEqual({ minor: 200, currency: 'USD' });
    expect(costOf('gpt-5.6-luna', MTOK)).toEqual({ minor: 20, currency: 'USD' });
    expect(costOf('gpt-5.6-sol', { ...MTOK, inputTokens: 0, outputTokens: 1_000_000 })).toEqual({
      minor: 3_000,
      currency: 'USD',
    });
  });

  /**
   * `gpt-4o` and the `o1` family cache at 0.5x their input rate, where `costOf` assumes 0.1x — a
   * spec for them would under-report a cache-heavy workload by four fifths. A wrong price is worse
   * than no entry, because the missing one says so and the wrong one does not.
   */
  test('do not include a model this package cannot price correctly', () => {
    expect(OPENAI_MODEL_IDS).not.toContain('gpt-4o');
    expect(() => modelSpec('gpt-4o')).toThrow(/X_AI_MODEL_UNKNOWN|no registered spec/);
  });

  test('take reasoning_effort and nothing else — the format has no adaptive control', () => {
    for (const id of OPENAI_MODEL_IDS) {
      expect(modelSpec(id).reasoning).toEqual({
        effort: true,
        adaptive: false,
        disableThinkingUpTo: undefined,
      });
      expect(modelSpec(id).maxOutput).toBe(128_000);
    }
  });

  test('are registered through the public path, so an app can restate one at its own rate', () => {
    const spec = modelSpec('gpt-5.6-sol');
    const rung = modelIds().indexOf('gpt-5.6-sol');
    registerModel({ ...spec, inputPerMillion: { minor: 250, currency: 'USD' } });

    expect(costOf('gpt-5.6-sol', MTOK)).toEqual({ minor: 250, currency: 'USD' });
    // A negotiated rate replaces the price and keeps the rung; it is not a new, weakest model.
    expect(modelIds().indexOf('gpt-5.6-sol')).toBe(rung);
    registerOpenAiModels();
  });
});

/**
 * `moreCapableThan` walks one flat, cross-vendor list, so the rung above `gpt-5.6-sol` was
 * `claude-haiku-4-5` — a different vendor, the CHEAPEST model in the catalogue, and very likely an
 * id the app's configured provider does not serve at all. That is the fix line `X_LLM_REFUSED`
 * hands an operator to paste, so it has to name a model that is both real here and actually above.
 */
describe('the ladder does not cross vendors', () => {
  test('the top of one family has no rung above it, whatever was registered before it', () => {
    expect(moreCapableThan('gpt-5.6-sol')).toBeUndefined();
    expect(moreCapableThan(ANTHROPIC_MODEL_IDS[0])).toBeUndefined();
  });

  test('within a family the walk still goes up', () => {
    expect(moreCapableThan('gpt-5.6-luna')).toBe('gpt-5.6-terra');
    expect(moreCapableThan('gpt-5.6-terra')).toBe('gpt-5.6-sol');
    expect(moreCapableThan('claude-haiku-4-5')).toBe('claude-sonnet-5');
  });

  test('a model registered with no family compares only with the other unfamilied ones', () => {
    const bare = {
      contextWindow: 1,
      maxOutput: 1,
      inputPerMillion: { minor: 1, currency: 'USD' },
      outputPerMillion: { minor: 1, currency: 'USD' },
      cacheMinimumTokens: 0,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
    } as const;
    registerModel({ id: 'llama-internal-70b', ...bare });
    registerModel({ id: 'llama-internal-8b', ...bare });

    expect(moreCapableThan('llama-internal-8b')).toBe('llama-internal-70b');
    // Never the vendor rung above it in registration order.
    expect(moreCapableThan('llama-internal-70b')).toBeUndefined();
  });
});
