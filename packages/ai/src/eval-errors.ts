// The five X_EVAL_* codes, apart from ./errors only because one file has one job and the catalogue
// outgrew its ceiling. The codes themselves, their titles and the single `registerErrorCodes` call
// stay in ./errors — one owner, one registration, one place a duplicate can surface.

import { UltimateError } from '@ultimat3/core';
import type { AiErrorCode } from './errors';

const docsFor = (code: AiErrorCode): string => `https://ultimate.dev/errors/${code}`;

/**
 * An eval scored further below its recorded baseline than its tolerance allows. The gate is the
 * DROP, not an absolute number — a model that got marginally worse everywhere is not the same
 * event as a prompt edit that broke one case, and only the second one is anybody's fault.
 *
 * This is a test failure, not a warning.
 */
export class EvalThresholdError extends UltimateError {
  constructor(input: {
    eval: string;
    score: number;
    baseline: number;
    tolerance: number;
    promptVersion: string;
    regressed: readonly string[];
  }) {
    super({
      code: 'X_EVAL_THRESHOLD',
      cause:
        `eval "${input.eval}" scored ${input.score.toFixed(3)} against a recorded baseline of ` +
        `${input.baseline.toFixed(3)} (tolerance ${input.tolerance.toFixed(3)}) on prompt ` +
        `version ${input.promptVersion}; regressed: ${input.regressed.join(', ')}`,
      fix: `x test ${input.eval} to see per-case scores, then fix the prompt — or ULTIMATE_EVAL_RECORD=1 x test eval to accept the new numbers as a reviewed diff`,
      docs: docsFor('X_EVAL_THRESHOLD'),
    });
  }
}

/**
 * An eval declared a baseline that has never been recorded. Not a pass: an eval with nothing to
 * compare against gates on nothing, and a step that cannot fail is a step that is not running.
 */
export class EvalBaselineMissingError extends UltimateError {
  constructor(input: { eval: string; path: string; reason: string; fix?: string }) {
    super({
      code: 'X_EVAL_BASELINE_MISSING',
      cause: `eval "${input.eval}" gates against ${input.path}, which ${input.reason}`,
      fix: input.fix ?? `ULTIMATE_EVAL_RECORD=1 x test eval, then commit ${input.path}`,
      docs: docsFor('X_EVAL_BASELINE_MISSING'),
    });
  }
}

/** A recorded baseline that cannot be read. Never treated as absent — that would erase a gate. */
export class EvalBaselineInvalidError extends UltimateError {
  constructor(input: { path: string; problem: string }) {
    super({
      code: 'X_EVAL_BASELINE_INVALID',
      cause: `the recorded baseline ${input.path} ${input.problem}`,
      fix: `ULTIMATE_EVAL_RECORD=1 x test eval to re-record ${input.path}`,
      docs: docsFor('X_EVAL_BASELINE_INVALID'),
    });
  }
}

/**
 * A registered prompt that no eval names. An unevaluated prompt is untested code that costs
 * money and answers users, so the gate fails on it exactly like an untyped module.
 */
export class EvalMissingError extends UltimateError {
  constructor(input: { prompt: string; id: string }) {
    super({
      code: 'X_EVAL_MISSING',
      cause: `prompt "${input.prompt}" has no eval`,
      fix: `defineEval({ name: '${input.id}', prompt, cases, scorers, tolerance, baseline }) beside the prompt, then ULTIMATE_EVAL_RECORD=1 x test eval`,
      docs: docsFor('X_EVAL_MISSING'),
    });
  }
}

/**
 * The gate ran with baseline recording switched on. Recording makes every eval write the numbers
 * it just measured and pass, so a `x verify` that inherited the flag reports green over scores
 * nothing compared — and rewrites the committed baselines on its way through, which is the half
 * a red step alone would not undo. Recording is a deliberate, reviewable diff, never a gate run.
 */
export class EvalRecordingError extends UltimateError {
  constructor(input: { env: string }) {
    super({
      code: 'X_EVAL_RECORDING',
      cause: `${input.env} is set, so every eval would re-record its baseline instead of gating on it`,
      fix: `env -u ${input.env} x verify`,
      docs: docsFor('X_EVAL_RECORDING'),
    });
  }
}
