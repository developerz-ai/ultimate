/**
 * The eval attached to `fixLinePrompt`. Cases live here rather than in the test file, matching
 * every app's own prompts — a fixture-driven, deterministic `exact` scorer, no judge, because
 * this is a proof of the eval mechanism itself and a proof that can drift is not one.
 */

import { defineEval } from './evals';
import { fixLinePrompt } from './fix-line';
import { exact } from './scorers';

export const fixLineCases = [
  {
    name: 'runnable/x-command',
    vars: { fixLine: 'bun run scripts/verify.ts --only lint,boundaries' },
    expected: 'runnable',
  },
  { name: 'runnable/cli-flag', vars: { fixLine: 'x db migrate' }, expected: 'runnable' },
  {
    name: 'vague/check',
    vars: { fixLine: 'check the configuration and try again' },
    expected: 'vague',
  },
  { name: 'vague/see-docs', vars: { fixLine: 'see the docs for details' }, expected: 'vague' },
];

export const fixLineEval = defineEval({
  name: 'ai.fix-line-runnable',
  prompt: fixLinePrompt,
  // The gate is the drop from this recorded score, never an absolute number: models drift,
  // prompts should not. Accepting a new number is a diff in the committed baseline file.
  baseline: import.meta.resolve('./fix-line.v1.baseline.json'),
  tolerance: 0.05,
  scorers: [exact],
  cases: fixLineCases,
});
