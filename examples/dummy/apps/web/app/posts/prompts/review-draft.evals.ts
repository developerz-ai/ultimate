/**
 * The eval attached to `posts.review-draft` — every prompt has one, or `x verify` fails it
 * (`X_EVAL_MISSING`). Cases here, scored by `review-draft.eval.test.ts`, for the reason
 * `summarize.evals.ts` gives: the gate reads this module without importing a test.
 *
 * Deterministic scorers only. A verdict is checked against the one each case was written to earn,
 * and the notes against the prompt's own three-sentence rule.
 */

import type { Scorer } from '@ultimat3/ai';
import { defineEval, jsonSchemaValid } from '@ultimat3/ai';
import { reviewDraftPrompt } from './review-draft';

/** `expected` is the verdict the draft was written to earn. */
export const reviewDraftCases = [
  {
    name: 'english/ready',
    expected: 'ready',
    vars: {
      locale: 'en',
      title: 'Money is an integer',
      body: 'Store every price as minor units beside its currency, and format it only at the edge — a float total drifts by a cent the first time two prices are added.',
    },
  },
  {
    name: 'english/revise',
    expected: 'revise',
    vars: {
      locale: 'en',
      title: 'Some thoughts',
      body: 'There are a few things. Some of them matter more than others, depending.',
    },
  },
  {
    name: 'spanish/ready',
    expected: 'ready',
    vars: {
      locale: 'es',
      title: 'Nadie formatea una fecha sin zona',
      body: 'Cada fecha se muestra en la zona de quien la lee: la zona vive en la membresía, nunca en el servidor.',
    },
  },
];

const parsed = (output: string): { verdict?: unknown; notes?: unknown } | undefined => {
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
};

/** The verdict the case was written to earn — the whole point of asking. */
export const verdictMatches: Scorer = {
  name: 'verdict-matches',
  score: ({ output, expected }) => (parsed(output)?.verdict === expected ? 1 : 0),
};

/** The prompt's own rule: at most three sentences of notes. */
export const withinThreeSentences: Scorer = {
  name: 'within-three-sentences',
  score({ output }) {
    const notes = parsed(output)?.notes;
    if (typeof notes !== 'string' || notes.trim() === '') return 0;
    return notes.split(/[.!?]+/).filter((part) => part.trim() !== '').length <= 3 ? 1 : 0;
  },
};

export const reviewDraftEval = defineEval({
  name: 'posts.review-draft',
  prompt: reviewDraftPrompt,
  baseline: import.meta.resolve('./review-draft.v1.baseline.json'),
  tolerance: 0.05,
  scorers: [jsonSchemaValid(['verdict', 'notes']), verdictMatches, withinThreeSentences],
  cases: reviewDraftCases,
});
