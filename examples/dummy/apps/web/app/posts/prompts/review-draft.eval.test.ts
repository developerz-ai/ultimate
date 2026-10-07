/**
 * eval — `posts.review-draft`, scored against recorded answers with the model and the prompt
 * version pinned, gated on a drop from the committed baseline (`review-draft.v1.baseline.json`).
 * The shape `summarize.eval.test.ts` set: one run that holds, one regression that is caught.
 */

import { echoProvider, providerGateway } from '@ultimat3/ai';
import { expect, test } from '@ultimat3/testing';
import { reviewDraftPrompt } from './review-draft';
import { reviewDraftCases, reviewDraftEval } from './review-draft.evals';

/** What the model answered when the baseline was recorded, keyed by case name. */
const RECORDED: Readonly<Record<string, string>> = {
  'english/ready': JSON.stringify({
    verdict: 'ready',
    notes: 'The title states the rule the body defends. The cent-drift example makes it concrete.',
  }),
  'english/revise': JSON.stringify({
    verdict: 'revise',
    notes: 'The title names no subject. Neither sentence says which things matter or why.',
  }),
  'spanish/ready': JSON.stringify({
    verdict: 'ready',
    notes: 'El título y el cuerpo defienden la misma regla. La zona en la membresía es la acción.',
  }),
};

/** A regression: the editor waves every draft through, at length. */
const REGRESSED: Readonly<Record<string, string>> = {
  'english/ready': JSON.stringify({ verdict: 'ready', notes: 'Great. Lovely. Ship it. Now.' }),
  'english/revise': JSON.stringify({ verdict: 'ready', notes: 'Looks good to me.' }),
  'spanish/ready': JSON.stringify({ verdict: 'ready', notes: 'Muy bien.' }),
};

const gatewayServing = (answers: Readonly<Record<string, string>>) =>
  providerGateway({
    providers: [
      echoProvider({
        replies: Object.fromEntries(
          reviewDraftCases.map((testCase) => [
            reviewDraftPrompt.render(testCase.vars),
            answers[testCase.name] ?? '',
          ]),
        ),
      }),
    ],
  });

test('review-draft holds its recorded scores across the fixture set', async () => {
  const run = await reviewDraftEval.assert(gatewayServing(RECORDED));

  expect(run.passed).toBe(true);
  expect(run.regressions).toEqual([]);
  expect(run.promptRef).toBe('posts.review-draft@1');
  expect(run.promptHash).toBe(reviewDraftPrompt.hash);
});

// Through `run`, never `assert`: `assert` re-records under ULTIMATE_EVAL_RECORD=1.
test('an editor that waves a vague draft through is caught, case by case', async () => {
  const run = await reviewDraftEval.run(gatewayServing(REGRESSED));

  expect(run.passed).toBe(false);
  expect(run.regressions.map((regression) => regression.case)).toEqual([
    'overall',
    'english/ready',
    'english/revise',
    // "Muy bien." — one sentence, the right verdict, and nothing a writer can act on.
    'spanish/ready',
  ]);
});
