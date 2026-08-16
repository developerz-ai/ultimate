// The recorded scores an eval gates against.
//
// The gate is the DELTA from the last accepted run, never an absolute number: models drift,
// prompts should not. An absolute floor fails every eval at once the day a provider ships a
// slightly different model, which trains everyone to lower thresholds until they mean nothing.
//
// A baseline is a committed file, so accepting a new number is a reviewable diff — and it
// carries the prompt ref and hash that produced it, because a score with no prompt attached is
// not a measurement.

import { isAbsolute } from 'node:path';
import { EvalBaselineInvalidError, EvalBaselineMissingError } from './eval-errors';

export interface EvalBaseline {
  readonly eval: string;
  /** `id@version` of the prompt that produced these numbers — usually the previous version. */
  readonly prompt: string;
  readonly promptHash: string;
  readonly score: number;
  /** Per-case scores, so the gate can name the case a prompt edit broke. */
  readonly cases: Readonly<Record<string, number>>;
}

/** One score that fell further than the eval's declared tolerance allows. */
export interface Regression {
  /** A case name, or `overall` for the run's mean. */
  readonly case: string;
  readonly baseline: number;
  readonly score: number;
}

/** The run-level entry, named so a failure reads the same whether one case or all of them fell. */
export const OVERALL = 'overall';

/** Set to re-record every baseline instead of gating on it: `ULTIMATE_EVAL_RECORD=1 x test eval`. */
export const RECORD_ENV = 'ULTIMATE_EVAL_RECORD';

export const recordingBaselines = (): boolean => (Bun.env[RECORD_ENV] ?? '') !== '';

/**
 * Where the baseline lives. Declarations write `import.meta.resolve('./x.baseline.json')`, which
 * is stable in a checkout and in a container; a cwd-relative path would resolve to a different
 * file depending on where the suite was started, which is how a gate silently stops gating.
 */
export function baselinePath(spec: string, evalName: string): string {
  if (spec.startsWith('file://')) return Bun.fileURLToPath(spec);
  if (isAbsolute(spec)) return spec;
  throw new EvalBaselineMissingError({
    eval: evalName,
    path: spec,
    reason: 'is neither an absolute path nor a file:// URL',
    fix: `baseline: import.meta.resolve('${spec}') in defineEval({ name: '${evalName}' })`,
  });
}

/** The recorded scores, or `undefined` when this eval has never been recorded. */
export async function readBaseline(path: string): Promise<EvalBaseline | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const parsed: unknown = await file.json().catch(() => undefined);
  return parseBaseline(parsed, path);
}

/** Fixed key order and a trailing newline: a re-record must diff as scores, not as formatting. */
export async function writeBaseline(path: string, baseline: EvalBaseline): Promise<void> {
  const ordered = {
    eval: baseline.eval,
    prompt: baseline.prompt,
    promptHash: baseline.promptHash,
    score: round(baseline.score),
    cases: Object.fromEntries(
      Object.keys(baseline.cases)
        .sort()
        .map((name) => [name, round(baseline.cases[name] ?? 0)]),
    ),
  };
  await Bun.write(path, `${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * Every score that dropped further than `tolerance`. The run mean AND each case, because a mean
 * that holds while one case collapses is the regression an eval exists to catch.
 *
 * A case the baseline does not know is not compared — a new case has nothing to regress from,
 * and the run mean already covers whatever it scores.
 */
export function regressionsAgainst(input: {
  readonly baseline: EvalBaseline;
  readonly score: number;
  readonly cases: Readonly<Record<string, number>>;
  readonly tolerance: number;
}): readonly Regression[] {
  const found: Regression[] = [];
  const fell = (was: number, now: number): boolean => now < was - input.tolerance;
  if (fell(input.baseline.score, input.score)) {
    found.push({ case: OVERALL, baseline: input.baseline.score, score: input.score });
  }
  for (const [name, was] of Object.entries(input.baseline.cases)) {
    const now = input.cases[name];
    if (now !== undefined && fell(was, now)) found.push({ case: name, baseline: was, score: now });
  }
  return found;
}

/** `case 0.40 ← 0.95` — the two numbers a reader needs, in the order they happened. */
export const describeRegression = (regression: Regression): string =>
  `${regression.case} ${regression.score.toFixed(2)} ← ${regression.baseline.toFixed(2)}`;

/** Three decimals: enough to see a real drift, few enough that noise is not a diff. */
const round = (value: number): number => Math.round(value * 1000) / 1000;

function parseBaseline(value: unknown, path: string): EvalBaseline {
  const invalid = (problem: string): never => {
    throw new EvalBaselineInvalidError({ path, problem });
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('is not a JSON object');
  }
  const record = value as Record<string, unknown>;
  const text = (key: string): string =>
    typeof record[key] === 'string' ? (record[key] as string) : invalid(`has no string "${key}"`);
  const score = record['score'];
  if (typeof score !== 'number') invalid('has no number "score"');
  const cases = record['cases'];
  if (typeof cases !== 'object' || cases === null || Array.isArray(cases)) {
    invalid('has no object "cases"');
  }
  const scores: Record<string, number> = {};
  for (const [name, entry] of Object.entries(cases as Record<string, unknown>)) {
    if (typeof entry !== 'number') invalid(`has a non-numeric score for case "${name}"`);
    scores[name] = entry as number;
  }
  return {
    eval: text('eval'),
    prompt: text('prompt'),
    promptHash: text('promptHash'),
    score: score as number,
    cases: scores,
  };
}
