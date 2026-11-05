/**
 * The contract step's exercise loop, once for `@ultimat3/action` and `@ultimat3/query` (both tier
 * 3, neither may import the other): seeded draws, the verdict on each run, the replay command and
 * the refusals before a run. Each adapter supplies the draw, the schema check and one attempt.
 */

import { assert } from './assert';
import type { ErrorStatusOf } from './declared-errors';
import { resolveEnvironment } from './environment';
import { isFixShellSafe, renderThrowable } from './error-render';
import { isUltimateError } from './errors';
import { ExerciseEnvironmentError, ExerciseUnscopedError } from './exercise-errors';
import { fnv1a } from './fnv1a';

/** Runs per exercise by default: sixteen invocations, four of them on the IR's bounds. */
export const EXERCISE_RUNS = 16;
/** The most a caller may raise `runs` to: every run is a real invocation. */
export const EXERCISE_RUNS_MAX = 64;

type Env = Readonly<Record<string, string | undefined>>;

/** One run's end. `reached` is the adapter's probe: did the handler (or `sql()`) start? */
export type ExerciseAttempt =
  | { readonly ok: true; readonly reached: boolean }
  | { readonly ok: false; readonly reached: boolean; readonly error: unknown };

/** What a passing exercise saw. */
export interface ExerciseReport {
  readonly runs: number;
  readonly reached: number;
  readonly refused: number;
  readonly outcomes: readonly string[];
}

/** What the adapter hands the loop. `env` exists for a test; a caller leaves it out. */
export interface ExerciseSubject {
  readonly name: string;
  readonly runs?: number | undefined;
  /** How an outcome reads when the run stopped before the probe: `stopped before sql()`. */
  readonly stoppedLabel: string;
  draw(seed: number, run: number): unknown;
  readonly bind?: ((drawn: unknown) => unknown) | undefined;
  accepts(input: unknown): Promise<boolean>;
  attempt(input: unknown): Promise<ExerciseAttempt>;
  readonly statusOf: ErrorStatusOf;
  readonly env?: Env | undefined;
  /** A write: whether a transaction undoes each attempt. Omitted by a read, which writes nothing. */
  readonly scoped?: boolean | undefined;
}

/** The loop's answer. Returned, never thrown: the codes are the adapter's to raise. */
export type ExerciseVerdict =
  | { readonly kind: 'pass'; readonly report: ExerciseReport }
  | {
      readonly kind: 'defect';
      readonly run: number;
      readonly input: unknown;
      readonly defect: string;
      readonly error: unknown;
    }
  | { readonly kind: 'unreached'; readonly outcomes: readonly string[] }
  | { readonly kind: 'drift' };

/** A thrown value's verdict: `null` is a pass (a coded refusal under 500), else what was wrong. */
export function exerciseDefect(error: unknown, statusOf: ErrorStatusOf): string | null {
  if (!isUltimateError(error)) return `threw an uncoded ${renderThrowable(error)}`;
  if (error.code === 'X_OUTPUT_INVALID') return 'returned a value its output schema rejects';
  // An unmapped code answers 500 on the wire, so it is a 500 here.
  const status = statusOf(error.code) ?? 500;
  return status >= 500 ? `answered ${error.code}, a ${status}` : null;
}

/** The host a sealed-network refusal names, read off its cause (`GET https://host/... was ...`). */
export function sealedHost(cause: string): string {
  const url = /^\S+ (\S+) was not mocked/.exec(cause)?.[1];
  if (url === undefined || !URL.canParse(url)) return 'an unnamed host';
  return new URL(url).host;
}

/**
 * `bun test <this file> -t '<testName>'` when a test file is running — the seed is the name, so
 * that replays the exact run — and the step otherwise. Single quotes are safe only around a name
 * `isFixShellSafe` already carries verbatim; `testName` is that name plus fixed words.
 */
export function exerciseReplay(name: string, testName: string): string {
  const main = Bun.main;
  const file = main.replace(`${process.cwd()}/`, '');
  if (!main.includes('.test.') || !isFixShellSafe(file) || !isFixShellSafe(name)) {
    return 'x verify --only contract';
  }
  return `bun test ${file} -t '${testName}'`;
}

/**
 * Refuse when no transaction would undo the writes — no client installed, none open — anywhere
 * but `test`, where the store is memory. Outside it the handler's writes reach `DATABASE_URL`.
 */
export function assertExerciseScoped(name: string, scoped: boolean, env?: Env): void {
  const environment = resolveEnvironment(env === undefined ? undefined : { env });
  if (!scoped && environment !== 'test') throw new ExerciseUnscopedError(name, environment);
}

/** Exercise `subject`: refuse a deploy, then draw, check, attempt and judge each run. */
export async function runExercise(subject: ExerciseSubject): Promise<ExerciseVerdict> {
  const { name } = subject;
  const environment = resolveEnvironment(
    subject.env === undefined ? undefined : { env: subject.env },
  );
  if (environment !== 'development' && environment !== 'test') {
    throw new ExerciseEnvironmentError(name, environment);
  }
  if (subject.scoped !== undefined) assertExerciseScoped(name, subject.scoped, subject.env);
  const runs = subject.runs ?? EXERCISE_RUNS;
  assert(
    Number.isInteger(runs) && runs >= 1 && runs <= EXERCISE_RUNS_MAX,
    `${name}: exercise runs must be a whole number from 1 to ${EXERCISE_RUNS_MAX}`,
    `${name}.contract({ exercise: { actor, runs: ${EXERCISE_RUNS} } })`,
  );
  const seed = fnv1a(name);
  const outcomes: string[] = [];
  let reached = 0;
  let refused = 0;
  for (let run = 0; run < runs; run += 1) {
    const drawn = subject.draw(seed, run);
    const input = subject.bind === undefined ? drawn : await subject.bind(drawn);
    if (!(await subject.accepts(input))) {
      refused += 1;
      outcomes.push(`run ${run}: input refused by its own schema`);
      continue;
    }
    const attempt = await subject.attempt(input);
    if (attempt.ok) {
      reached += attempt.reached ? 1 : 0;
      outcomes.push(`run ${run}: answered`);
      continue;
    }
    // Before the verdict: the sealed network is the test's wall, not the handler's failure, and
    // its code maps to no status, so `exerciseDefect` would read it as a 500.
    const { error } = attempt;
    if (isUltimateError(error) && error.code === 'X_TEST_NETWORK_SEALED') {
      outcomes.push(`run ${run}: network sealed (${sealedHost(error.cause)})`);
      continue;
    }
    const defect = exerciseDefect(error, subject.statusOf);
    if (defect !== null) return { kind: 'defect', run, input, defect, error };
    const code = isUltimateError(error) ? error.code : 'uncoded';
    reached += attempt.reached ? 1 : 0;
    outcomes.push(`run ${run}: ${attempt.reached ? 'refused' : subject.stoppedLabel} with ${code}`);
  }
  if (refused === runs) return { kind: 'drift' };
  if (reached === 0) return { kind: 'unreached', outcomes };
  return { kind: 'pass', report: { runs, reached, refused, outcomes } };
}
