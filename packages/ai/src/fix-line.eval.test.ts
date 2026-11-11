// Holds @ultimat3/ai's committed fix-line evaluation baseline and regression cases.

import { expect, test } from 'bun:test';
import { echoProvider } from './echo-provider';
import { fixLineCases, fixLineEval } from './fix-line.evals-fixture';
import { fixLinePrompt } from './fix-line-fixture';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';

// The framework registers no model: this suite registers the rows it names (`model-fixture.ts`).
useFixtureModels();

/** What the model answered when this baseline was recorded, keyed by case name. */
const RECORDED: Readonly<Record<string, string>> = {
  'runnable/x-command': 'runnable',
  'runnable/cli-flag': 'runnable',
  'vague/check': 'vague',
  'vague/see-docs': 'vague',
};

/** A prompt regression: the classifier answers every case backwards. */
const REGRESSED: Readonly<Record<string, string>> = {
  'runnable/x-command': 'vague',
  'runnable/cli-flag': 'vague',
  'vague/check': 'runnable',
  'vague/see-docs': 'runnable',
};

/** Answers keyed by the rendered prompt — the fixture set, so the eval is a test, not a sample. */
const gatewayServing = (answers: Readonly<Record<string, string>>) =>
  providerGateway({
    defaultModel: FIXTURE_MODEL,
    providers: [
      echoProvider({
        replies: Object.fromEntries(
          fixLineCases.map((testCase) => [
            fixLinePrompt.render(testCase.vars),
            answers[testCase.name] ?? '',
          ]),
        ),
      }),
    ],
  });

test('fix-line holds its recorded score across the fixture set', async () => {
  const run = await fixLineEval.assert(gatewayServing(RECORDED));

  expect(run.passed).toBe(true);
  expect(run.regressions).toEqual([]);
  // A score is not a measurement without the prompt that produced it.
  expect(run.promptRef).toBe('ai.fix-line-runnable@1');
  expect(run.promptHash).toBe(fixLinePrompt.hash);
});

// Through `run`, never `assert`: `assert` re-records under ULTIMATE_EVAL_RECORD=1, and a test
// that deliberately feeds it a worse model would overwrite the baseline during a record pass.
test('a classifier that answers every case backwards is caught, case by case', async () => {
  const run = await fixLineEval.run(gatewayServing(REGRESSED));

  expect(run.passed).toBe(false);
  expect(run.score).toBeLessThan(run.baseline ?? 1);
  expect(run.regressions.map((regression) => regression.case)).toEqual([
    'overall',
    'runnable/cli-flag',
    'runnable/x-command',
    'vague/check',
    'vague/see-docs',
  ]);
});
