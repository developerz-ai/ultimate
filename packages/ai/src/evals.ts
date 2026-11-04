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

import { finiteCount } from '@ultimat3/core';
import type { AgentEvalInput, CaseOutcome } from './eval-agent';
import { agentPrompt, runAgentCase } from './eval-agent';
import type { EvalBaseline, Regression } from './eval-baseline';
import {
  baselinePath,
  describeRegression,
  readBaseline,
  recordingBaselines,
  regressionsAgainst,
  writeBaseline,
} from './eval-baseline';
import { EvalBaselineMissingError, EvalThresholdError } from './eval-errors';
import type { Gateway } from './gateway';
import type { Prompt, PromptVars } from './prompt';
import { describePrompts } from './prompt';
import type { EvalRun, Scorer } from './scorers';
import { clampScore } from './scorers';

export type { AgentEvalCase, AgentEvalInput, EvaluatedAgent } from './eval-agent';

/** One case: the variables to render with, plus what a good answer looks like. */
export interface EvalCase<V extends PromptVars = PromptVars> {
  readonly name: string;
  readonly vars: V;
  /** Reference answer, or the substring/JSON the scorers check for. */
  readonly expected?: string;
}

/** The prompt arm: one rendered request per case, no tools — for a prompt `llm()` sends. */
export interface PromptEvalInput<V extends PromptVars = PromptVars> {
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

/**
 * Either arm. `agent` runs the whole loop — the agent's tools (as the eval's doubles) and turns —
 * because a prompt that says "answer through the respond tool" measured in a request offering no
 * tool describes something the agent never runs. Narrow with `'prompt' in input`.
 */
export type DefineEvalInput<V extends PromptVars = PromptVars> =
  | PromptEvalInput<V>
  | AgentEvalInput;

export interface CaseResult {
  readonly case: string;
  readonly output: string;
  readonly score: number;
  readonly perScorer: Readonly<Record<string, number>>;
  /** Agent arm: what the run did — its turns and the tools it called, in order. */
  readonly run?: { readonly turns: number; readonly toolCalls: readonly string[] };
  /** Agent arm: the code a failed run threw. The case scored 0; the suite went on. */
  readonly failed?: string;
}

export interface EvalResult {
  readonly name: string;
  readonly promptRef: string;
  /** The prompt content hash. A score means nothing without it. */
  readonly promptHash: string;
  /** The agent the agent arm ran, by its registered name. Absent on the prompt arm. */
  readonly agent?: string;
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
  /** The prompt measured: the arm's own, or the one the agent runs on. */
  readonly prompt: Prompt<V>;
  /** The agent arm's agent, by its registered name; `''` until registration names it. */
  readonly agent?: string;
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
  /** The agent arm's agent; absent on the prompt arm. */
  readonly agent?: string;
  readonly tolerance: number;
  readonly baseline: string;
}

const registry = new Map<string, Eval>();

/** One way to declare an eval, two arms: `prompt` (one request per case) or `agent` (one run). */
export function defineEval<V extends PromptVars>(input: PromptEvalInput<V>): Eval<V>;
export function defineEval<I>(input: AgentEvalInput<I>): Eval;
export function defineEval(input: DefineEvalInput): Eval {
  const prompt = 'prompt' in input ? input.prompt : agentPrompt(input.agent, input.name);
  const evaluation: Eval = {
    name: input.name,
    prompt,
    // A getter: an agent is named by `registerAction` at boot, after this ran at module scope.
    ...('agent' in input
      ? {
          get agent() {
            return input.agent.name;
          },
        }
      : {}),
    tolerance: input.tolerance,
    baseline: input.baseline,
    run: (gateway) => runEval(input, prompt, gateway),
    assert: (gateway) => assertEval(input, prompt, gateway),
  };
  registry.set(input.name, evaluation);
  return evaluation;
}

export function describeEvals(): readonly EvalFact[] {
  return [...registry.values()]
    .map((evaluation) => ({
      name: evaluation.name,
      prompt: evaluation.prompt.ref,
      promptId: evaluation.prompt.id,
      ...(evaluation.agent === undefined ? {} : { agent: evaluation.agent }),
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

async function assertEval(
  input: DefineEvalInput,
  prompt: Prompt,
  gateway: Gateway,
): Promise<EvalResult> {
  const path = baselinePath(input.baseline, input.name);
  const result = await runEval(input, prompt, gateway);

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

async function runEval(
  input: DefineEvalInput,
  prompt: Prompt,
  gateway: Gateway,
): Promise<EvalResult> {
  const cases: CaseResult[] = [];
  const outcomes =
    'prompt' in input
      ? input.cases.map((testCase) => ({
          testCase,
          outcome: () => promptCase(input, testCase.vars, gateway),
        }))
      : input.cases.map((testCase) => ({
          testCase,
          outcome: () => runAgentCase(input, testCase, gateway),
        }));
  // Serial, as before: a case is a paid call (an agent case, several), and order is the report's.
  for (const { testCase, outcome } of outcomes) {
    cases.push(await scoreCase(input.scorers, testCase, await outcome()));
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
    promptRef: prompt.ref,
    promptHash: prompt.hash,
    ...('agent' in input ? { agent: input.agent.name } : {}),
    score,
    baseline: recorded?.score,
    tolerance: input.tolerance,
    regressions,
    passed: recorded !== undefined && regressions.length === 0,
    cases,
  };
}

/** The prompt arm's one request: the rendered prompt, no tools. */
async function promptCase(
  input: PromptEvalInput,
  vars: PromptVars,
  gateway: Gateway,
): Promise<CaseOutcome> {
  const generated = await gateway.generate({
    messages: [{ role: 'user' as const, content: input.prompt.render(vars) }],
    // A ceiling of `NaN` is not a ceiling: it becomes the pre-flight estimate, passes every
    // budget check and then poisons the ledger it was checked against. Refused here, per RUN,
    // because `defineEval` takes it as a plain field and there is no earlier seam.
    maxTokens: finiteCount('defineEval', 'maxTokens', input.maxTokens ?? 1_024, 1),
    ...(input.prompt.system !== undefined ? { system: input.prompt.system } : {}),
    ...(input.prompt.model !== undefined ? { model: input.prompt.model } : {}),
    ...(input.prompt.effort !== undefined ? { effort: input.prompt.effort } : {}),
    // `thinking` too, and not because it is tidy: `promptHash` covers it, so the baseline is
    // filed under a hash describing a configuration the measurement did not use. `llm()` and
    // `agent()` have always sent both.
    ...(input.prompt.thinking !== undefined ? { thinking: input.prompt.thinking } : {}),
  });
  return { ok: true, output: generated.text };
}

/** Every scorer over one outcome. A failed agent run scores 0 on every scorer, and says why. */
async function scoreCase(
  scorers: readonly Scorer[],
  testCase: { readonly name: string; readonly expected?: string },
  outcome: CaseOutcome,
): Promise<CaseResult> {
  const perScorer: Record<string, number> = {};
  for (const scorer of scorers) {
    perScorer[scorer.name] = outcome.ok
      ? clampScore(
          await scorer.score({
            output: outcome.output,
            ...(testCase.expected !== undefined ? { expected: testCase.expected } : {}),
            ...(outcome.run === undefined ? {} : { run: outcome.run }),
          }),
        )
      : 0;
  }
  return {
    case: testCase.name,
    output: outcome.ok ? outcome.output : '',
    score: mean(Object.values(perScorer)),
    perScorer,
    ...(outcome.ok && outcome.run !== undefined ? { run: reported(outcome.run) } : {}),
    ...(outcome.ok ? {} : { failed: outcome.code }),
  };
}

const reported = (run: EvalRun): NonNullable<CaseResult['run']> => ({
  turns: run.turns,
  toolCalls: run.toolCalls.map((call) => call.name),
});

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
