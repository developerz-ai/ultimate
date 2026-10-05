/**
 * The prompt behind `fix-line` — `@ultimat3/ai`'s own dogfood eval, and the package's first
 * framework-level `*.eval.test.ts`. Not an app feature: every app that declares a prompt is
 * required to pair it with an eval and a committed baseline (`defineEval`, `X_EVAL_MISSING`,
 * `X_EVAL_BASELINE_MISSING`), and this proves that whole convention actually catches a
 * regression from inside the package that owns it — through the real opt-in suite `x verify`'s
 * `eval` step runs, not only through `evals.test.ts`'s unit fixtures against a temp-dir baseline.
 *
 * The task is small on purpose: classify whether an error's `fix:` line is a runnable command —
 * axiom 4, "errors are instructions" — or vague guidance ("check the config", "see the docs").
 */

import { definePrompt } from './prompt';

export const fixLinePrompt = definePrompt<{ fixLine: string }>({
  id: 'ai.fix-line-runnable',
  version: '1',
  template:
    'Reply with exactly one word: "runnable" if the fix line below names a command to run, or ' +
    '"vague" if it only describes what to do without naming one.\nFix line: {{fixLine}}',
  input: {
    type: 'object',
    properties: { fixLine: { type: 'string' } },
    required: ['fixLine'],
  },
  output: { type: 'string', enum: ['runnable', 'vague'] },
});
