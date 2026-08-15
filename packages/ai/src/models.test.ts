/**
 * The catalogue's two claims about itself: `MODEL_IDS` is ordered most-capable-first, so a
 * refusal can be answered with a real upgrade rather than a downgrade; and `reasoningBody`
 * sends a control only when the caller asked for one.
 */

import { describe, expect, test } from 'bun:test';
import { AiRequestInvalidError } from './errors';
import { DEFAULT_MODEL, MODEL_IDS, MODELS, moreCapableThan, reasoningBody } from './models';

describe('moreCapableThan', () => {
  // The measured failure: `MODEL_IDS.find((id) => id !== result.model)` answered a refusal on
  // the default model with `claude-sonnet-5` — the fix line told an operator to retry a refusal
  // on a weaker model, which is the one retry that cannot help.
  test('has no answer for the most capable model, rather than a downgrade', () => {
    expect(moreCapableThan(DEFAULT_MODEL)).toBeUndefined();
    expect(moreCapableThan(MODEL_IDS[0] as (typeof MODEL_IDS)[number])).toBeUndefined();
  });

  test('walks UP the ladder, never down', () => {
    for (let i = 1; i < MODEL_IDS.length; i += 1) {
      const model = MODEL_IDS[i];
      if (model === undefined) continue;
      const better = moreCapableThan(model);
      expect(better).toBe(MODEL_IDS[i - 1] as (typeof MODEL_IDS)[number]);
      // "More capable" is not a vibe here: the ladder is priced, and the rung above costs more.
      expect(MODELS[better ?? DEFAULT_MODEL].outputPerMillion.minor).toBeGreaterThan(
        MODELS[model].outputPerMillion.minor,
      );
    }
  });

  test('the catalogue is ordered most capable first, which is what makes the walk sound', () => {
    const prices = MODEL_IDS.map((id) => MODELS[id].outputPerMillion.minor);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
  });
});

describe('reasoningBody omits what nobody asked for', () => {
  // The comment above `reasoningBody` claimed this; the code emitted an adaptive block for every
  // adaptive-capable model whether or not the declaration mentioned thinking.
  test('sends no thinking block when the declaration named no mode', () => {
    for (const model of MODEL_IDS) {
      expect(reasoningBody(model, undefined, undefined)['thinking']).toBeUndefined();
    }
  });

  test('sends no output_config when the declaration named no effort', () => {
    for (const model of MODEL_IDS) {
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
