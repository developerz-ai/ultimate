/**
 * The catalogue's claims about itself: registration order is the capability ladder, so a refusal
 * can be answered with a real upgrade rather than a downgrade; `reasoningBody` sends a control
 * only when the caller asked for one; and — the reason the registry exists — a model an APP
 * registered is priced by its own spec, never by whatever Anthropic charges for a Claude id.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { NOT_A_BOUND, refusal } from './bounds-fixture';
import { AiModelUnknownError, AiRequestInvalidError } from './errors';
import {
  ANTHROPIC_MODEL_IDS,
  DEFAULT_MODEL,
  isModelRegistered,
  modelIds,
  modelSpec,
  moreCapableThan,
  reasoningBody,
  registerModel,
  resetModels,
} from './models';
import { costOf } from './provider';

const GATEWAY_MODEL = 'llama-internal-70b';

afterEach(() => {
  resetModels();
});

describe('the registry is open', () => {
  // The blocker this replaced: `ModelId` was a three-entry union, so an internal gateway's model
  // did not typecheck. The only way past `tsc` was `models: ['claude-opus-5']` — and then every
  // call to a $0.20/MTok internal model was priced, reserved and reported at $5/$25.
  test('prices a registered foreign model by ITS spec, not by Anthropic list price', () => {
    registerModel({
      id: GATEWAY_MODEL,
      contextWindow: 128_000,
      maxOutput: 8_192,
      inputPerMillion: { minor: 20, currency: 'USD' },
      outputPerMillion: { minor: 40, currency: 'USD' },
      cacheMinimumTokens: 0,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
    });
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(costOf(GATEWAY_MODEL, usage)).toEqual({ minor: 60, currency: 'USD' });
    // What the lie cost before: the same call billed as Opus.
    expect(costOf('claude-opus-5', usage)).toEqual({ minor: 3_000, currency: 'USD' });
  });

  test('an unregistered id is refused where it would be priced, naming what IS registered', () => {
    expect(isModelRegistered(GATEWAY_MODEL)).toBe(false);
    expect(() =>
      costOf(GATEWAY_MODEL, {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toThrow(AiModelUnknownError);
    try {
      modelSpec(GATEWAY_MODEL);
      expect.unreachable();
    } catch (error) {
      expect((error as { cause: string }).cause).toContain('claude-opus-5');
      expect((error as { fix: string }).fix).toContain('registerModel(');
    }
  });

  // The negotiated-rate case. Same id, new prices, and every downstream number follows — a
  // contract price that could not be expressed silently defeated the budget ledger.
  test('re-registering an id replaces its prices and keeps its rung on the ladder', () => {
    const before = modelIds();
    registerModel({
      ...modelSpec('claude-opus-5'),
      inputPerMillion: { minor: 250, currency: 'USD' },
    });
    expect(modelIds()).toEqual(before);
    expect(
      costOf('claude-opus-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toEqual({ minor: 250, currency: 'USD' });
    expect(moreCapableThan('claude-sonnet-5')).toBe('claude-opus-5');
  });

  test('resetModels restores exactly the built-in catalogue', () => {
    registerModel({
      id: GATEWAY_MODEL,
      contextWindow: 1,
      maxOutput: 1,
      inputPerMillion: { minor: 1, currency: 'USD' },
      outputPerMillion: { minor: 1, currency: 'USD' },
      cacheMinimumTokens: 0,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
    });
    expect(modelIds()).toHaveLength(ANTHROPIC_MODEL_IDS.length + 1);
    resetModels();
    expect(modelIds()).toEqual([...ANTHROPIC_MODEL_IDS]);
  });
});

describe('moreCapableThan', () => {
  // The measured failure: `MODEL_IDS.find((id) => id !== result.model)` answered a refusal on
  // the default model with `claude-sonnet-5` — the fix line told an operator to retry a refusal
  // on a weaker model, which is the one retry that cannot help.
  test('has no answer for the most capable model, rather than a downgrade', () => {
    expect(moreCapableThan(DEFAULT_MODEL)).toBeUndefined();
    expect(moreCapableThan(ANTHROPIC_MODEL_IDS[0])).toBeUndefined();
  });

  test('has no answer for a model nobody registered, rather than the bottom rung', () => {
    expect(moreCapableThan(GATEWAY_MODEL)).toBeUndefined();
  });

  test('walks UP the ladder, never down', () => {
    for (let i = 1; i < ANTHROPIC_MODEL_IDS.length; i += 1) {
      const model = ANTHROPIC_MODEL_IDS[i];
      if (model === undefined) continue;
      const better = moreCapableThan(model);
      expect(better).toBe(ANTHROPIC_MODEL_IDS[i - 1] as string);
      // "More capable" is not a vibe here: the ladder is priced, and the rung above costs more.
      expect(modelSpec(better ?? DEFAULT_MODEL).outputPerMillion.minor).toBeGreaterThan(
        modelSpec(model).outputPerMillion.minor,
      );
    }
  });

  test('the catalogue is ordered most capable first, which is what makes the walk sound', () => {
    const prices = ANTHROPIC_MODEL_IDS.map((id) => modelSpec(id).outputPerMillion.minor);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
  });
});

describe('reasoningBody omits what nobody asked for', () => {
  // The comment above `reasoningBody` claimed this; the code emitted an adaptive block for every
  // adaptive-capable model whether or not the declaration mentioned thinking.
  test('sends no thinking block when the declaration named no mode', () => {
    for (const model of ANTHROPIC_MODEL_IDS) {
      expect(reasoningBody(model, undefined, undefined)['thinking']).toBeUndefined();
    }
  });

  test('sends no output_config when the declaration named no effort', () => {
    for (const model of ANTHROPIC_MODEL_IDS) {
      expect(reasoningBody(model, undefined, undefined)['output_config']).toBeUndefined();
    }
  });

  test('sends exactly what the declaration DID name', () => {
    const body = reasoningBody(DEFAULT_MODEL, 'high', 'adaptive');
    expect(body['output_config']).toEqual({ effort: 'high' });
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  test('still refuses a control the model does not have', () => {
    expect(() => reasoningBody('claude-haiku-4-5', 'high', undefined)).toThrow(
      AiRequestInvalidError,
    );
    expect(() => reasoningBody('claude-haiku-4-5', undefined, 'adaptive')).toThrow(
      AiRequestInvalidError,
    );
  });

  test("still refuses 'disabled' above the model's cap", () => {
    expect(() => reasoningBody(DEFAULT_MODEL, 'max', 'disabled')).toThrow(AiRequestInvalidError);
    expect(reasoningBody(DEFAULT_MODEL, 'high', 'disabled')['thinking']).toEqual({
      type: 'disabled',
    });
  });
});

/**
 * A row an app registers carries five numbers, and two of them reach places nothing screens.
 *
 * `maxOutput` reaches the pre-flight ESTIMATE through `Math.min(request.maxTokens, spec.maxOutput)`
 * — which propagates a `NaN` rather than screening it — and a `NaN` estimate passes every budget
 * check and then writes itself onto the ledger and the per-process `BudgetStore`, where every
 * later comparison against it is false too. A price is the same story for the money ceiling, and
 * `costOf` answers confidently either way: a wrong price is worse than a missing one, which is
 * why three OpenAI models are deliberately absent from this catalogue rather than guessed at.
 */
describe('registerModel refuses a row it cannot price or bound', () => {
  const spec = (over: Partial<Parameters<typeof registerModel>[0]>) => () =>
    registerModel({
      id: GATEWAY_MODEL,
      contextWindow: 128_000,
      maxOutput: 8_192,
      inputPerMillion: { minor: 20, currency: 'USD' },
      outputPerMillion: { minor: 40, currency: 'USD' },
      cacheMinimumTokens: 0,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
      ...over,
    });

  test('every numeric field is refused under a name carrying the model id', () => {
    for (const value of NOT_A_BOUND) {
      expect(refusal(spec({ maxOutput: value })).cause).toContain('maxOutput');
      expect(refusal(spec({ contextWindow: value })).cause).toContain('contextWindow');
      expect(refusal(spec({ cacheMinimumTokens: value })).cause).toContain('cacheMinimumTokens');
      expect(refusal(spec({ inputPerMillion: { minor: value, currency: 'USD' } })).cause).toContain(
        'inputPerMillion',
      );
      expect(
        refusal(spec({ outputPerMillion: { minor: value, currency: 'USD' } })).cause,
      ).toContain('outputPerMillion');
    }
    // The id is in the option name, because a boot that registers a catalogue needs to know WHICH
    // row it has to go and edit.
    expect(refusal(spec({ maxOutput: Number.NaN })).cause).toContain(GATEWAY_MODEL);
    expect(refusal(spec({ maxOutput: Number.NaN })).fix).toContain('registerModel');
  });

  test('a price is integer minor units, so a fractional one is refused with the rest', () => {
    // The framework's money rule, enforced where a price enters the catalogue rather than
    // discovered as a rounding difference in a recorded cost.
    expect(refusal(spec({ inputPerMillion: { minor: 20.5, currency: 'USD' } })).code).toBe(
      'X_INVARIANT',
    );
  });

  test('a free model still registers — a zero price is a price', () => {
    expect(spec({ inputPerMillion: { minor: 0, currency: 'USD' } })).not.toThrow();
    expect(isModelRegistered(GATEWAY_MODEL)).toBe(true);
  });
});
