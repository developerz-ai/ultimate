/**
 * eval — scored, not pass/fail on a vibe. Runs against recorded answers with the model and the
 * prompt version pinned, and gates on a drop from the recorded baseline rather than on an
 * absolute score: models drift, prompts should not.
 *
 * `x verify` fails if a prompt edit makes this worse. A prompt with no evals file fails it too —
 * see `summarize.evals.ts`, which is where the cases live.
 */

import { createGateway, EchoProvider } from '@ultimat3/ai';
import { expect, test } from '@ultimat3/testing';
import { summarizePrompt } from './summarize';
import { summarizeCases, summarizeEval } from './summarize.evals';

/** What the model answered when this baseline was recorded, keyed by case name. */
const RECORDED: Readonly<Record<string, string>> = {
  'english/tenancy': JSON.stringify({
    summary:
      'Every table carries an org id and every index leads with it. A forgotten filter fails the query instead of leaking rows.',
    tags: ['tenancy', 'column', 'index'],
  }),
  'spanish/timezones': JSON.stringify({
    summary:
      'La zona horaria vive en la membresía, así que cada fecha se muestra en la zona de quien la lee. El resumen llega a las 09:00 locales.',
    tags: ['zona', 'fecha', 'resumen'],
  }),
  'short-body/passthrough': JSON.stringify({
    summary: 'Money is an integer: minor units and a currency.',
    // `prices` appears nowhere in the post — the one imperfect score in the baseline, kept so
    // the recorded numbers describe a real model rather than a flattering one.
    tags: ['money', 'minor', 'currency', 'prices'],
  }),
};

/** A prompt regression: every answer invents tags and rambles past the two-sentence rule. */
const REGRESSED: Readonly<Record<string, string>> = {
  'english/tenancy': JSON.stringify({
    summary:
      'This post is about tenancy. It explains that tables carry an org id. It also mentions indexes. Finally it warns about leaks.',
    tags: ['scaling', 'devops'],
  }),
  'spanish/timezones': JSON.stringify({
    summary: 'Este artículo habla de zonas. Explica husos. Menciona correos. Y termina.',
    tags: ['calendario', 'correo'],
  }),
  'short-body/passthrough': JSON.stringify({
    summary: 'Money matters. Integers matter. Currencies matter. Rounding matters.',
    tags: ['billing', 'stripe'],
  }),
};

/** Answers keyed by the rendered prompt — the fixture set, so the eval is a test, not a sample. */
const gatewayServing = (answers: Readonly<Record<string, string>>) =>
  createGateway({
    providers: [
      new EchoProvider({
        replies: Object.fromEntries(
          summarizeCases.map((testCase) => [
            summarizePrompt.render(testCase.vars),
            answers[testCase.name] ?? '',
          ]),
        ),
      }),
    ],
  });

test('summarize holds its recorded scores across the fixture set', async () => {
  const run = await summarizeEval.assert(gatewayServing(RECORDED));

  expect(run.passed).toBe(true);
  expect(run.regressions).toEqual([]);
  // A score is not a measurement without the prompt that produced it.
  expect(run.promptRef).toBe('posts.summarize@4');
  expect(run.promptHash).toBe(summarizePrompt.hash);
});

// Through `run`, never `assert`: `assert` re-records under ULTIMATE_EVAL_RECORD=1, and a test
// that deliberately feeds it a worse model would overwrite the baseline during a record pass.
// `run` scores and compares without gating, which is the half this test is about.
test('a prompt that invents tags again is caught, case by case', async () => {
  const run = await summarizeEval.run(gatewayServing(REGRESSED));

  expect(run.passed).toBe(false);
  expect(run.score).toBeLessThan(run.baseline ?? 1);
  expect(run.regressions.map((regression) => regression.case)).toEqual([
    'overall',
    'english/tenancy',
    'short-body/passthrough',
    'spanish/timezones',
  ]);
});
