// Evals are a test type.
//
// Not a notebook, not a dashboard, not a weekly report — a `bun test` case that fails CI.
// A prompt change that drops a score below its recorded baseline should break the build exactly
// like a type error does, because the consequence is the same: shipping something wrong.
//
// The gate is the DROP, never the absolute score: an absolute floor fails every eval at once the
// day the provider ships a slightly different model, which teaches everyone to lower thresholds
// until they measure nothing. `tolerance` is how far a score may fall before it is a regression.
//
// Every result is filed against a prompt's content hash, so a score is always attributable
// to an exact prompt rather than "whatever was in main that day".

import { EvalBaselineMissingError, EvalThresholdError } from './errors';
import type { EvalBaseline, Regression } from './eval-baseline';
import {
  baselinePath,
  describeRegression,
  readBaseline,
  recordingBaselines,
  regressionsAgainst,
  writeBaseline,
} from './eval-baseline';
import type { Gateway } from './gateway';
import type { Prompt, PromptVars } from './prompt';
import { describePrompts } from './prompt';
import type { Scorer } from './scorers';
import { clampScore } from './scorers';

/** One case: the variables to render with, plus what a good answer looks like. */
export interface EvalCase<V extends PromptVars = PromptVars> {
  readonly name: string;
  readonly vars: V;
  /** Reference answer, or the substring/JSON the scorers check for. */
  readonly expected?: string;
}

export interface DefineEvalInput<V extends PromptVars = PromptVars> {
  readonly name: string;
  readonly prompt: Prompt<V>;
  readonly cases: readonly EvalCase<V>[];
  readonly scorers: readonly Scorer[];
  /**
   * The committed scores this run is compared against. Write it as
   * `import.meta.resolve('./name.baseline.json')` — a cwd-relative path resolves to a different
   * file depending on where the suite was started.
   */
  readonly baseline: string;
  /** How far a score may fall before it is a regression. Explicit: widening it is a diff. */
  readonly tolerance: number;
  readonly maxTokens?: number;
}

export interface CaseResult {
  readonly case: string;
  readonly output: string;
  readonly score: number;
  readonly perScorer: Readonly<Record<string, number>>;
}

export interface EvalResult {
  readonly name: string;
  readonly promptRef: string;
  /** The prompt content hash. A score means nothing without it. */
  readonly promptHash: string;
  readonly score: number;
  /** The recorded run mean, or `undefined` when this eval has never been recorded. */
  readonly baseline: number | undefined;
  readonly tolerance: number;
  /** Every score that fell further than `tolerance` — the run mean and each case. */
  readonly regressions: readonly Regression[];
  /** A baseline exists and nothing regressed. Anything else is a red gate. */
  readonly passed: boolean;
  readonly cases: readonly CaseResult[];
}

export interface Eval<V extends PromptVars = PromptVars> {
  readonly name: string;
  readonly prompt: Prompt<V>;
  readonly tolerance: number;
  /** The baseline file, as declared — what `x verify` reports when it cannot be read. */
  readonly baseline: string;
  /** Score every case against the baseline. Never throws on a regression — `assert` does that. */
  run(gateway: Gateway): Promise<EvalResult>;
  /**
   * Run and throw `X_EVAL_THRESHOLD` on a regression. This is the line a test file calls, so a
   * prompt edit that broke a case is a red test naming that case and both its scores.
   *
   * Under `ULTIMATE_EVAL_RECORD=1` it writes the baseline instead of gating on it.
   */
  assert(gateway: Gateway): Promise<EvalResult>;
}

/** What `x verify` reads to decide whether every prompt is evaluated. */
export interface EvalFact {
  readonly name: string;
  readonly prompt: string;
  readonly promptId: string;
  readonly tolerance: number;
  readonly baseline: string;
}

const registry = new Map<string, Eval>();

export function defineEval<V extends PromptVars>(input: DefineEvalInput<V>): Eval<V> {
  const evaluation: Eval<V> = {
    name: input.name,
    prompt: input.prompt,
    tolerance: input.tolerance,
    baseline: input.baseline,
    run: (gateway) => runEval(input, gateway),
    assert: (gateway) => assertEval(input, gateway),
  };
  registry.set(input.name, evaluation as Eval);
  return evaluation;
}

export function describeEvals(): readonly EvalFact[] {
  return [...registry.values()]
    .map((evaluation) => ({
      name: evaluation.name,
      prompt: evaluation.prompt.ref,
      promptId: evaluation.prompt.id,
      tolerance: evaluation.tolerance,
      baseline: evaluation.baseline,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Every registered prompt no eval names, by ID rather than by version: old versions are retained
 * so traces stay interpretable, and an eval on the current version evaluates that lineage.
 */
export function promptsWithoutEvals(): readonly Prompt[] {
  const covered = new Set([...registry.values()].map((evaluation) => evaluation.prompt.id));
  return describePrompts().filter((prompt) => !covered.has(prompt.id));
}

export function resetEvals(): void {
  registry.clear();
}

async function assertEval<V extends PromptVars>(
  input: DefineEvalInput<V>,
  gateway: Gateway,
): Promise<EvalResult> {
  const path = baselinePath(input.baseline, input.name);
  const result = await runEval(input, gateway);

  if (recordingBaselines()) {
    await writeBaseline(path, baselineFrom(result));
    return { ...result, baseline: result.score, regressions: [], passed: true };
  }
  if (result.baseline === undefined) {
    throw new EvalBaselineMissingError({
      eval: input.name,
      path,
      reason: 'has never been recorded',
    });
  }
  if (result.regressions.length > 0) {
    throw new EvalThresholdError({
      eval: result.name,
      score: result.score,
      baseline: result.baseline,
      tolerance: result.tolerance,
      promptVersion: `${result.promptRef} (${result.promptHash})`,
      regressed: result.regressions.map(describeRegression),
    });
  }
  return result;
}

async function runEval<V extends PromptVars>(
  input: DefineEvalInput<V>,
  gateway: Gateway,
): Promise<EvalResult> {
  const cases: CaseResult[] = [];
  for (const testCase of input.cases) {
    const generated = await gateway.generate({
      messages: [{ role: 'user' as const, content: input.prompt.render(testCase.vars) }],
      maxTokens: input.maxTokens ?? 1_024,
      ...(input.prompt.system !== undefined ? { system: input.prompt.system } : {}),
      ...(input.prompt.model !== undefined ? { model: input.prompt.model } : {}),
      ...(input.prompt.effort !== undefined ? { effort: input.prompt.effort } : {}),
    });
    const perScorer: Record<string, number> = {};
    for (const scorer of input.scorers) {
      perScorer[scorer.name] = clampScore(
        await scorer.score({
          output: generated.text,
          ...(testCase.expected !== undefined ? { expected: testCase.expected } : {}),
        }),
      );
    }
    cases.push({
      case: testCase.name,
      output: generated.text,
      score: mean(Object.values(perScorer)),
      perScorer,
    });
  }

  const score = mean(cases.map((c) => c.score));
  const recorded = await readBaseline(baselinePath(input.baseline, input.name));
  const regressions =
    recorded === undefined
      ? []
      : regressionsAgainst({
          baseline: recorded,
          score,
          cases: caseScores(cases),
          tolerance: input.tolerance,
        });

  return {
    name: input.name,
    promptRef: input.prompt.ref,
    promptHash: input.prompt.hash,
    score,
    baseline: recorded?.score,
    tolerance: input.tolerance,
    regressions,
    passed: recorded !== undefined && regressions.length === 0,
    cases,
  };
}

const caseScores = (cases: readonly CaseResult[]): Record<string, number> =>
  Object.fromEntries(cases.map((c) => [c.case, c.score]));

/** What a run records: the numbers, and the exact prompt that produced them. */
export const baselineFrom = (result: EvalResult): EvalBaseline => ({
  eval: result.name,
  prompt: result.promptRef,
  promptHash: result.promptHash,
  score: result.score,
  cases: caseScores(result.cases),
});

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
