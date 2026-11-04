/**
 * eval — `posts.review-draft`, the agent arm: each case is a whole `reviewDraft` run over a seeded
 * post, answered by recorded turns with the model and the prompt version pinned, gated on a drop
 * from the committed baseline (`review-draft.v2.baseline.json`). The shape `summarize.eval.test.ts`
 * set: one run that holds, one regression that is caught — and here, the run's tool calls.
 */

import type { ScriptedTurn } from '@ultimat3/ai';
import { providerGateway, scriptedProvider } from '@ultimat3/ai';
import { expect, test } from '@ultimat3/testing';
import { reviewDraftPrompt } from './review-draft';
import { reviewDraftCases, reviewDraftEval } from './review-draft.evals';

type Answer = { readonly verdict: string; readonly notes: string };

/** One case's recorded run: ask the feed's summary of the post, then answer. */
const looksThenAnswers = (
  testCase: (typeof reviewDraftCases)[number],
  answer: Answer,
): readonly ScriptedTurn[] => [{ call: 'summarize', input: testCase.input }, { answer }];

/** What the model answered when the baseline was recorded, keyed by case name. */
const RECORDED: Readonly<Record<string, Answer>> = {
  'english/draft-money': {
    verdict: 'ready',
    notes: 'The title states the rule the body defends. The cent-drift example makes it concrete.',
  },
  'english/tenancy': {
    verdict: 'ready',
    notes: 'The title names the rule. The body says what a forgotten filter costs.',
  },
  'english/timezones': {
    verdict: 'ready',
    notes: 'The title names the rule. The body says where the zone lives and why.',
  },
};

/** A regression: the editor waves every draft through, at length, without looking. */
const REGRESSED: Readonly<Record<string, Answer>> = {
  'english/draft-money': { verdict: 'ready', notes: 'Great. Lovely. Ship it. Now.' },
  'english/tenancy': { verdict: 'revise', notes: 'Looks good to me.' },
  'english/timezones': { verdict: 'ready', notes: 'Muy bien.' },
};

/** The `dev` graph, written: `pick` is what waits for the seed to finish. */
const seeded = (
  seed: (name: string) => { pick(labels: Record<string, string>): Promise<unknown> },
) => seed('dev').pick({ draft: 'post:draft-money' });

/** Every case's turns, in case order: one scripted model serves the whole run. */
const gatewayServing = (answers: Readonly<Record<string, Answer>>, look = true) =>
  providerGateway({
    providers: [
      scriptedProvider({
        turns: reviewDraftCases.flatMap((testCase) => {
          const answer = answers[testCase.name] ?? { verdict: '', notes: '' };
          return look ? looksThenAnswers(testCase, answer) : [{ answer }];
        }),
      }),
    ],
  });

test('review-draft holds its recorded scores, and its report shows the tool it called', async ({
  seed,
}) => {
  await seeded(seed);
  const run = await reviewDraftEval.assert(gatewayServing(RECORDED));

  expect(run.passed).toBe(true);
  expect(run.regressions).toEqual([]);
  expect(run.agent).toBe('reviewDraft');
  expect(run.promptRef).toBe('posts.review-draft@2');
  expect(run.promptHash).toBe(reviewDraftPrompt.hash);
  expect(run.cases.map((c) => c.run)).toEqual(
    reviewDraftCases.map(() => ({ turns: 2, toolCalls: ['summarize'] })),
  );
});

// Through `run`, never `assert`: `assert` re-records under ULTIMATE_EVAL_RECORD=1.
test('an editor that waves a draft through without looking is caught, case by case', async ({
  seed,
}) => {
  await seeded(seed);
  const run = await reviewDraftEval.run(gatewayServing(REGRESSED, false));

  expect(run.passed).toBe(false);
  expect(run.regressions.map((regression) => regression.case)).toEqual([
    'overall',
    'english/draft-money',
    'english/tenancy',
    // "Muy bien." — one sentence, the right verdict, and nothing a writer can act on.
    'english/timezones',
  ]);
});
