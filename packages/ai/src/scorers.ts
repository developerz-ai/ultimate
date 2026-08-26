// What a scorer is, and the built-in ones.
//
// A scorer returns 0..1 for one answer. Deterministic scorers are preferred and cheap; a judge
// is a model call, which means it is itself a measuring instrument that can drift — so its
// prompt is a versioned artifact and its hash is part of the scorer's name.

import { finiteCount } from '@ultimat3/core';
import type { Gateway } from './gateway';
import type { Prompt } from './prompt';

/** A scorer returns 0..1. Deterministic scorers are preferred; judges are a last resort. */
export interface Scorer {
  readonly name: string;
  score(input: { output: string; expected?: string }): Promise<number> | number;
}

/**
 * Scores outside 0..1 are a scorer bug; clamping keeps one from skewing a whole run's mean.
 *
 * `NaN` is the case a pair of comparisons cannot express, and it is the dangerous one: both
 * `n < 0` and `n > 1` are false for it, so it propagated through `mean()` into `EvalResult.score`,
 * and `regressionsAgainst`'s `now < was - tolerance` is false for `NaN` too — the run reported a
 * pass over a number that measured nothing. The trigger is ordinary arithmetic in an app's own
 * scorer: `output.length / expected.length` on a case that declares no `expected`.
 *
 * Zero rather than a throw, and rather than a new code: zero is a REGRESSION against any recorded
 * baseline, so the scorer bug surfaces through `X_EVAL_THRESHOLD`, which already names the case
 * that produced it. It also makes recording and gating agree — `ULTIMATE_EVAL_RECORD=1` wrote
 * `"score": null` for a `NaN`, which `parseBaseline` then refuses as `X_EVAL_BASELINE_INVALID`.
 */
export const clampScore = (n: number): number =>
  Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : n > 0 ? 1 : 0;

/** Exact match after trimming. The strictest and cheapest scorer; prefer it when it fits. */
export const exact: Scorer = {
  name: 'exact',
  score: ({ output, expected }) => (output.trim() === (expected ?? '').trim() ? 1 : 0),
};

/** Case-insensitive substring. For "did it mention X" without pinning the phrasing. */
export const contains: Scorer = {
  name: 'contains',
  score: ({ output, expected }) =>
    expected !== undefined && output.toLowerCase().includes(expected.toLowerCase()) ? 1 : 0,
};

/** Output parses as JSON. Pairs with a prompt that declares an `output` schema. */
export const jsonValid: Scorer = {
  name: 'json-valid',
  score: ({ output }) => {
    try {
      JSON.parse(output);
      return 1;
    } catch {
      return 0;
    }
  },
};

/** Output parses AND satisfies the required keys of `schema`. */
export function jsonSchemaValid(required: readonly string[]): Scorer {
  return {
    name: 'json-schema-valid',
    score: ({ output }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        return 0;
      }
      if (typeof parsed !== 'object' || parsed === null) return 0;
      const record = parsed as Record<string, unknown>;
      const present = required.filter((key) => record[key] !== undefined).length;
      return required.length === 0 ? 1 : present / required.length;
    },
  };
}

/** Graded numeric closeness — 1 at exact, 0 at or beyond `tolerance`. */
export function numericTolerance(tolerance: number): Scorer {
  return {
    name: 'numeric-tolerance',
    score: ({ output, expected }) => {
      const got = Number.parseFloat(output.trim());
      const want = Number.parseFloat((expected ?? '').trim());
      if (Number.isNaN(got) || Number.isNaN(want)) return 0;
      const delta = Math.abs(got - want);
      return delta >= tolerance ? 0 : 1 - delta / tolerance;
    },
  };
}

/**
 * LLM-as-judge. The judge prompt is itself a versioned artifact, so a judge change is a new
 * hash and every score it produced is re-attributable. A judge whose prompt drifts silently
 * is a measuring instrument that lies.
 */
export function llmJudge(input: {
  readonly gateway: Gateway;
  readonly judge: Prompt<{ output: string; expected: string }>;
  readonly maxTokens?: number;
}): Scorer {
  return {
    name: `llm-judge@${input.judge.hash}`,
    async score({ output, expected }) {
      const generated = await input.gateway.generate({
        messages: [
          {
            role: 'user',
            content: input.judge.render({ output, expected: expected ?? '' }),
          },
        ],
        // Same rule as every other completion ceiling here, and this one is read per SCORE: a
        // `NaN` reaches the gateway as the estimate, and an estimate that is not a number turns
        // the ambient budget off rather than exceeding it.
        maxTokens: finiteCount('llmJudge', 'maxTokens', input.maxTokens ?? 256, 1),
        ...(input.judge.system !== undefined ? { system: input.judge.system } : {}),
        ...(input.judge.model !== undefined ? { model: input.judge.model } : {}),
        // The judge prompt's hash is this scorer's NAME, and `contentHash` covers `effort` and
        // `thinking` — so dropping either measures with a judge the name does not describe.
        ...(input.judge.effort !== undefined ? { effort: input.judge.effort } : {}),
        ...(input.judge.thinking !== undefined ? { thinking: input.judge.thinking } : {}),
      });
      // The judge is asked for a bare 0..1; anything else scores 0 rather than guessing.
      const parsed = Number.parseFloat(generated.text.trim());
      return Number.isNaN(parsed) ? 0 : clampScore(parsed);
    },
  };
}
