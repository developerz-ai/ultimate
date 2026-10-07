/**
 * The registry's rules over the rows an app registers (here, `model-fixture.ts`'s): each
 * reasoning shape is enforced locally, `costOf` uses a row's own cache rates, a refusal's
 * suggestion is a rung the same declaration can run on and never crosses a family, and a row
 * prices in one currency. Mechanism only — no number here is a vendor's claim.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AiRequestInvalidError } from './errors';
import { FIXTURE_ANTHROPIC_IDS, registerFixtureModels } from './model-fixture';
import { modelSpec, moreCapableThan, reasoningBody, registerModel, resetModels } from './models';
import { costOf, type TokenUsage } from './provider';

// Reset first: the registry is process state, and a row with no family another file left behind
// sits on the unfamilied ladder this file asserts.
beforeEach(() => {
  resetModels();
  registerFixtureModels();
});

afterEach(() => {
  resetModels();
});

const usd = (minor: number) => ({ minor, currency: 'USD' });

describe('the thinking rule each reasoning shape enforces', () => {
  // `disableThinkingUpTo: 'never'` — a 400 at EVERY effort, so it is refused here at every effort.
  test('an always-on row refuses thinking: disabled at every effort, naming the knob', () => {
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

  test('an always-on row still takes every effort rung and an explicit adaptive block', () => {
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

  // `disabledThinking: 'between_tools'` capped at `high`: the framework's one `thinking: 'disabled'`
  // is that request on such a row.
  test("a between_tools row sends between_tools for thinking: 'disabled', and only at high or below", () => {
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

  test('a capped row and an uncapped row keep their own rules', () => {
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
 * `costOf` per row, against sums worked by hand from each row's per-MTok fields (input, 5m cache
 * write, cache hit, output). One million of each, so each term is the row's own price.
 */
describe("costOf prices cache reads and writes at each row's own rate", () => {
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

  test('every fixture row: input + 5m write + cache hit + output', () => {
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

  // The bug this closes: a flat 0.1x read charged a 0.05x row twice and a 0.025x row four times over.
  test('the two discounted cache-hit rates, and rounding UP on a single token', () => {
    expect(costOf('claude-opus-5-5', ONLY('cacheReadTokens'))).toEqual(usd(20));
    expect(costOf('claude-fable-5-1', ONLY('cacheReadTokens'))).toEqual(usd(25));
    expect(costOf('claude-fable-5-1', ONLY('cacheReadTokens', 1))).toEqual(usd(1));
  });

  test('the OpenAI-format rows read cached input at their own rate', () => {
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

describe("a refusal's suggestion is a rung the same declaration can run on", () => {
  test('with no declaration it is the next rung up', () => {
    expect(moreCapableThan('claude-opus-5', {})).toBe('claude-opus-5-5');
  });

  test("from Opus 5 with thinking: 'disabled', every rung above refuses it, so there is none", () => {
    expect(
      moreCapableThan('claude-opus-5', { thinking: 'disabled', effort: 'high' }),
    ).toBeUndefined();
  });

  test('a rung that would refuse is skipped, and the climb lands on the next one that accepts', () => {
    const row = (id: string, disableThinkingUpTo: 'never' | undefined) =>
      registerModel({
        ...modelSpec('claude-opus-5'),
        id,
        family: 'acme',
        reasoning: { effort: true, adaptive: true, disableThinkingUpTo },
      });
    row('acme-top', undefined);
    row('acme-mid', 'never');
    row('acme-low', undefined);
    expect(moreCapableThan('acme-low', {})).toBe('acme-mid');
    expect(moreCapableThan('acme-low', { thinking: 'disabled' })).toBe('acme-top');
  });
});

describe('every price on a row is in one currency', () => {
  // `costOf` sums them into one Money stamped with the input currency, so a EUR cache rate on a
  // USD row would be added as dollars.
  test('a cache or output rate in another currency is refused at registration', () => {
    for (const field of [
      'cacheReadPerMillion',
      'cacheWritePerMillion',
      'outputPerMillion',
    ] as const) {
      try {
        registerModel({
          ...modelSpec('claude-opus-5'),
          id: 'acme-eur',
          [field]: { minor: 1, currency: 'EUR' },
        });
        expect.unreachable();
      } catch (error) {
        const { code, cause, fix } = error as { code: string; cause: string; fix: string };
        expect(code).toBe('X_INVARIANT');
        expect(cause).toContain(field);
        expect(fix.startsWith('registerModel({')).toBe(true);
        expect(fix).toContain('"USD"');
      }
    }
  });
});

/**
 * An app registering two vendors' rows puts one's top rung right after the other's cheapest. A
 * flat walk would hand `X_LLM_REFUSED`'s fix line the cheaper vendor's model to paste — so the
 * walk stops at the family boundary.
 */
describe('the ladder does not cross vendors', () => {
  test('the top of one family has no rung above it, whatever was registered before it', () => {
    expect(moreCapableThan('gpt-5.6-sol')).toBeUndefined();
    expect(moreCapableThan(FIXTURE_ANTHROPIC_IDS[0])).toBeUndefined();
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
