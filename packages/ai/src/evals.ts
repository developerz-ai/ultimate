// Evals are a test type.
//
// Not a notebook, not a dashboard, not a weekly report — a `bun test` case that fails CI.
// A prompt change that drops accuracy below its threshold should break the build exactly
// like a type error does, because the consequence is the same: shipping something wrong.
//
// Every result is filed against a prompt's content hash, so a score is always attributable
// to an exact prompt rather than "whatever was in main that day".

import { EvalThresholdError } from './errors.ts';
import type { Gateway } from './gateway.ts';
import type { Prompt, PromptVars } from './prompt.ts';

/** One case: the variables to render with, plus what a good answer looks like. */
export interface EvalCase<V extends PromptVars = PromptVars> {
  readonly name: string;
  readonly vars: V;
  /** Reference answer, or the substring/JSON the scorers check for. */
  readonly expected?: string;
}

/** A scorer returns 0..1. Deterministic scorers are preferred; judges are a last resort. */
export interface Scorer {
  readonly name: string;
  score(input: { output: string; expected?: string }): Promise<number> | number;
}

export interface DefineEvalInput<V extends PromptVars = PromptVars> {
  readonly name: string;
  readonly prompt: Prompt<V>;
  readonly cases: readonly EvalCase<V>[];
  readonly scorers: readonly Scorer[];
  /** Mean score below this fails. Explicit, so lowering it is a reviewable diff. */
  readonly threshold: number;
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
  readonly threshold: number;
  readonly passed: boolean;
  readonly cases: readonly CaseResult[];
}

export interface Eval<V extends PromptVars = PromptVars> {
  readonly name: string;
  readonly prompt: Prompt<V>;
  readonly threshold: number;
  /** Score every case. Never throws on a low score — `assert` does that. */
  run(gateway: Gateway): Promise<EvalResult>;
  /**
   * Run and throw `X_EVAL_THRESHOLD` if below threshold. This is the line a test file
   * calls, so a regression is a red test with the worst cases named in the message.
   */
  assert(gateway: Gateway): Promise<EvalResult>;
}

const registry = new Map<string, Eval>();

export function defineEval<V extends PromptVars>(input: DefineEvalInput<V>): Eval<V> {
  const evaluation: Eval<V> = {
    name: input.name,
    prompt: input.prompt,
    threshold: input.threshold,
    run: (gateway) => runEval(input, gateway),
    async assert(gateway) {
      const result = await runEval(input, gateway);
      if (!result.passed) {
        throw new EvalThresholdError({
          eval: result.name,
          score: result.score,
          threshold: result.threshold,
          promptVersion: `${result.promptRef} (${result.promptHash})`,
          worst: worstCases(result.cases),
        });
      }
      return result;
    },
  };
  registry.set(input.name, evaluation as Eval);
  return evaluation;
}

export function describeEvals(): readonly { name: string; prompt: string; threshold: number }[] {
  return [...registry.values()]
    .map((e) => ({ name: e.name, prompt: e.prompt.ref, threshold: e.threshold }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function resetEvals(): void {
  registry.clear();
}

async function runEval<V extends PromptVars>(
  input: DefineEvalInput<V>,
  gateway: Gateway,
): Promise<EvalResult> {
  const cases: CaseResult[] = [];
  for (const testCase of input.cases) {
    const request = {
      messages: [{ role: 'user' as const, content: input.prompt.render(testCase.vars) }],
      maxTokens: input.maxTokens ?? 1_024,
      ...(input.prompt.system !== undefined ? { system: input.prompt.system } : {}),
      ...(input.prompt.model !== undefined ? { model: input.prompt.model } : {}),
      ...(input.prompt.effort !== undefined ? { effort: input.prompt.effort } : {}),
    };
    const generated = await gateway.generate(request);
    const perScorer: Record<string, number> = {};
    for (const scorer of input.scorers) {
      perScorer[scorer.name] = clamp(
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
  return {
    name: input.name,
    promptRef: input.prompt.ref,
    promptHash: input.prompt.hash,
    score,
    threshold: input.threshold,
    passed: score >= input.threshold,
    cases,
  };
}

/** The three lowest-scoring case names — what a failure message must contain to be useful. */
function worstCases(cases: readonly CaseResult[]): readonly string[] {
  return [...cases]
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((c) => `${c.case}=${c.score.toFixed(2)}`);
}

const clamp = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

// ── built-in scorers ─────────────────────────────────────────────────────────

/** Exact match after trimming. The strictest and cheapest scorer; prefer it when it fits. */
export const exact: Scorer = {
  name: 'exact',
  score: ({ output, expected }) => (output.trim() === (expected ?? '').trim() ? 1 : 0),
};

/** Case-insensitive substring. For "did it mention X" without pinning the phrasing. */
export const contains: Scorer = {
  name: 'contains',
  score: ({ output, expected }) =>
    expected !== undefined && output.toLowerCase().includes(expected.toLowerCase()) ? 1 : 0,
};

/** Output parses as JSON. Pairs with a prompt that declares an `output` schema. */
export const jsonValid: Scorer = {
  name: 'json-valid',
  score: ({ output }) => {
    try {
      JSON.parse(output);
      return 1;
    } catch {
      return 0;
    }
  },
};

/** Output parses AND satisfies the required keys of `schema`. */
export function jsonSchemaValid(required: readonly string[]): Scorer {
  return {
    name: 'json-schema-valid',
    score: ({ output }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        return 0;
      }
      if (typeof parsed !== 'object' || parsed === null) return 0;
      const record = parsed as Record<string, unknown>;
      const present = required.filter((key) => record[key] !== undefined).length;
      return required.length === 0 ? 1 : present / required.length;
    },
  };
}

/** Graded numeric closeness — 1 at exact, 0 at or beyond `tolerance`. */
export function numericTolerance(tolerance: number): Scorer {
  return {
    name: 'numeric-tolerance',
    score: ({ output, expected }) => {
      const got = Number.parseFloat(output.trim());
      const want = Number.parseFloat((expected ?? '').trim());
      if (Number.isNaN(got) || Number.isNaN(want)) return 0;
      const delta = Math.abs(got - want);
      return delta >= tolerance ? 0 : 1 - delta / tolerance;
    },
  };
}

/**
 * LLM-as-judge. The judge prompt is itself a versioned artifact, so a judge change is a new
 * hash and every score it produced is re-attributable. A judge whose prompt drifts silently
 * is a measuring instrument that lies.
 */
export function llmJudge(input: {
  readonly gateway: Gateway;
  readonly judge: Prompt<{ output: string; expected: string }>;
  readonly maxTokens?: number;
}): Scorer {
  return {
    name: `llm-judge@${input.judge.hash}`,
    async score({ output, expected }) {
      const generated = await input.gateway.generate({
        messages: [
          {
            role: 'user',
            content: input.judge.render({ output, expected: expected ?? '' }),
          },
        ],
        maxTokens: input.maxTokens ?? 256,
        ...(input.judge.system !== undefined ? { system: input.judge.system } : {}),
        ...(input.judge.model !== undefined ? { model: input.judge.model } : {}),
      });
      // The judge is asked for a bare 0..1; anything else scores 0 rather than guessing.
      const parsed = Number.parseFloat(generated.text.trim());
      return Number.isNaN(parsed) ? 0 : clamp(parsed);
    },
  };
}
