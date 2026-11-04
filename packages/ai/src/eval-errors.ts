// The six X_EVAL_* codes, apart from ./errors only because one file has one job and the catalogue
// outgrew its ceiling. The codes themselves, their titles and the single `registerErrorCodes` call
// stay in ./error-codes — one owner, one registration, one place a duplicate can surface.

import { UltimateError } from '@ultimat3/core';

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`,
// which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
// `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE ROW,
// which has no anchor. The `https://ultimate.dev/errors/<code>` links this file built until 9.x
// answered 404, host included, on every error it has ever thrown; restating the replacement here
// would be the same constant in eight places waiting to drift again.

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
      // `x test eval --filter <name>`, never `x test <name>`: `x test`'s positional is a TestType,
      // so the eval's own name there is `X_CLI_BAD_FLAG` ("not a test type") — a fix line that
      // cannot be run is axiom 4 broken at the one moment it is needed.
      fix: `x test eval --filter ${input.eval} to see per-case scores, then fix the prompt — or ULTIMATE_EVAL_RECORD=1 x test eval to accept the new numbers as a reviewed diff`,
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
    });
  }
}

/** A recorded baseline that cannot be read. Never treated as absent — that would erase a gate. */
export class EvalBaselineInvalidError extends UltimateError {
  constructor(input: { path: string; problem: string }) {
    super({
      code: 'X_EVAL_BASELINE_INVALID',
      cause: `the recorded baseline ${input.path} ${input.problem}`,
      // The command is the record run; the path is named behind the `#`, where it is read and
      // never run — `x test eval` takes no path, and a file name may carry `$(…)` (sweep 1c).
      fix: `ULTIMATE_EVAL_RECORD=1 x test eval   # re-records ${input.path}`,
    });
  }
}

/**
 * A registered prompt that no eval names. An unevaluated prompt is untested code that costs
 * money and answers users, so the gate fails on it exactly like an untyped module.
 */
export class EvalMissingError extends UltimateError {
  /** `agent`: the agent the prompt drives, so the fix names the arm that runs its tools and turns. */
  constructor(input: { prompt: string; id: string; agent?: string }) {
    const arm =
      input.agent === undefined
        ? 'prompt, cases, scorers'
        : `agent: ${input.agent}, cases, tools, scorers`;
    super({
      code: 'X_EVAL_MISSING',
      cause:
        input.agent === undefined
          ? `prompt "${input.prompt}" has no eval`
          : `prompt "${input.prompt}" has no eval, and agent ${input.agent} runs on it`,
      fix: `defineEval({ name: '${input.id}', ${arm}, tolerance, baseline }) beside the prompt, then ULTIMATE_EVAL_RECORD=1 x test eval`,
    });
  }
}

/**
 * An agent eval's model called a tool the eval declares no double for. An eval NEVER runs a real
 * tool — a case that reached one in CI would write — so the run ends here rather than reading the
 * call as a tool failure the model could route around, or scoring it 0 and letting a recording
 * accept it. Thrown out of `run` / `assert`: the eval is misdeclared, not the agent regressed.
 */
export class EvalToolUndoubledError extends UltimateError {
  constructor(input: { eval: string; tool: string; doubled: readonly string[] }) {
    const doubled = input.doubled.length === 0 ? 'none' : input.doubled.join(', ');
    super({
      code: 'X_EVAL_TOOL_UNDOUBLED',
      cause: `agent eval "${input.eval}" ran a case whose model called ${input.tool}, which has no double (doubled: ${doubled}); an eval never runs a real tool`,
      fix: `tools: { ${input.tool}: (input) => ({ /* what the tool answers */ }) }   # on defineEval({ name: '${input.eval}' })`,
      meta: { eval: input.eval, tool: input.tool },
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
    });
  }
}
