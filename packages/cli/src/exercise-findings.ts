// What `x exercise` makes of a pass's records: one finding per `unreached` primitive (its fix is
// `exercise-findings-unreached.ts`'s), per crossed tenant and diverged crash proof; the counts; the
// table; the one report `--json` and `.x/exercise.json` hold. Pure — records in, plain values out —
// so the gate step and the command cannot disagree about what is red.

// why: Bun ships no path joiner.
import { join } from 'node:path';
import {
  ERROR_DOCS_URL,
  renderCauseValue,
  renderFixLiteral,
  renderFixShellArg,
} from '@ultimat3/core';
import type { ExercisePhaseMs, ExerciseRecord, ProofMs } from '@ultimat3/testing';
import { crashEffectPlace, planSweepFindings, tenantProofFindings } from '@ultimat3/testing';
import type { ExerciseFileFacts } from './exercise-findings-unreached';
import { unreachedFinding } from './exercise-findings-unreached';
import { msg } from './messages';
import type { Finding } from './output';
import { renderTable } from './table';

/** Where the pass's report is written, app-root-relative: state, gitignored with the rest of `.x/`. */
export const EXERCISE_REPORT_FILE = join('.x', 'exercise.json');

export type { ExerciseFileFacts } from './exercise-findings-unreached';
export { EXERCISE_FILE } from './exercise-findings-unreached';

type Outcome = ExerciseRecord['outcome'];

export interface ExerciseCounts {
  readonly total: number;
  readonly reached: number;
  readonly refused: number;
  readonly unreached: number;
  readonly off: number;
}

export const exerciseCounts = (records: readonly ExerciseRecord[]): ExerciseCounts => {
  const count = (outcome: Outcome): number =>
    records.filter((one) => one.outcome === outcome).length;
  return {
    total: records.length,
    reached: count('reached'),
    refused: count('refused'),
    unreached: count('unreached'),
    off: count('off'),
  };
};

type CrashFinding = Extract<
  NonNullable<ExerciseRecord['crash']>,
  { readonly verdict: 'diverged' }
>['findings'][number];

const crashFindingsOf = (record: ExerciseRecord): readonly CrashFinding[] =>
  record.crash?.verdict === 'diverged' ? record.crash.findings : [];

/**
 * `X_JOB_CRASH_DIVERGED`, testing's code: a reached job, killed at a step boundary, made an effect
 * a different number of times than a clean run. Where it ran — outside every `step.run`, or inside
 * one whose body re-runs — is testing's `crashEffectPlace`, the phrase its error uses too. One
 * finding per effect and place, every boundary that showed it named in the cause.
 */
const crashFindings = (record: ExerciseRecord): readonly Finding[] => {
  const groups = new Map<string, CrashFinding[]>();
  for (const one of crashFindingsOf(record)) {
    const key = `${one.effect}\u0000${one.after ?? ''}\u0000${one.inside ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), one]);
  }
  const job = renderFixShellArg(record.name, '<job>');
  return [...groups.values()].map((group): Finding => {
    const [first] = group as [CrashFinding, ...CrashFinding[]];
    const { place, remedy } = crashEffectPlace(first);
    const how =
      first.killed > first.clean
        ? 'the retry after a crash makes it again'
        : 'the crash skipped it';
    const at = group.map((one) => JSON.stringify(one.boundary)).join(', ');
    return {
      code: 'X_JOB_CRASH_DIVERGED',
      cause: `job ${renderCauseValue(record.name)} killed at ${at} made ${renderCauseValue(first.effect)} ${first.killed}× against ${first.clean}× in a clean run: ${place}, so ${how}`,
      fix: `x exercise ${job} --json   # in job(${renderFixLiteral(record.name, '<job>')}), for ${renderFixLiteral(first.effect, '<effect>')}: ${remedy}`,
      docs: ERROR_DOCS_URL,
      at: `${record.kind} ${record.name}`,
    };
  });
};

/** One line per killed boundary that diverged: `job chargeOrder · killed at mail · X_… effect 2×`. */
export const crashFindingLines = (records: readonly ExerciseRecord[]): readonly string[] =>
  records.flatMap((record) =>
    crashFindingsOf(record).map(
      (one) =>
        `${record.kind} ${record.name} · killed at ${one.boundary} · X_JOB_CRASH_DIVERGED ${one.effect} ${one.killed}× (clean ${one.clean}×)`,
    ),
  );

/**
 * Unreached primitives, then the tenant proof's crossed ones: tenant B handed A's data or changed
 * A's row; then the crash proof's diverged jobs. `unproven`, either proof's, is reported on the
 * record and never red — the pass could not ask, which is not an answer.
 */
export const exerciseFindings = (
  records: readonly ExerciseRecord[],
  file?: ExerciseFileFacts,
): readonly Finding[] => [
  ...records.filter((one) => one.outcome === 'unreached').map(unreachedFinding(file)),
  ...tenantProofFindings(records).map((one) => ({ ...one, docs: ERROR_DOCS_URL })),
  ...records.flatMap(crashFindings),
  // The plan and scale sweeps: a statement no index serves, a shape that grows with the rows.
  ...planSweepFindings(records).map((one) => ({ ...one, docs: ERROR_DOCS_URL })),
];

/** The pass's phases, and the subject proof the CLI runs after it on a database of its own. */
export interface ExercisePhases extends ExercisePhaseMs {
  readonly subject: number;
}

export interface ExerciseReport {
  /** What the pass ran on: `x exercise --seed <this>` replays it. */
  readonly seed: number;
  readonly counts: ExerciseCounts;
  /** Milliseconds per phase: absent only when the pass threw before it could say. */
  readonly phases?: ExercisePhases;
  readonly records: readonly ExerciseRecord[];
}

export const exerciseReport = (
  records: readonly ExerciseRecord[],
  seed: number,
  phases?: ExercisePhases,
): ExerciseReport => ({
  seed,
  counts: exerciseCounts(records),
  ...(phases === undefined ? {} : { phases }),
  records,
});

const PHASE_ORDER = ['seed', 'primitives', 'scale', 'plans', 'subject'] as const;

/** `took 10610 ms — seed 800 · primitives 9100 · … — slowest: primitives`. */
export function exercisePhaseLine(phases: ExercisePhases): string {
  const total = PHASE_ORDER.reduce((sum, key) => sum + phases[key], 0);
  const slowest = PHASE_ORDER.reduce((top, key) => (phases[key] > phases[top] ? key : top));
  return msg('cli.exercise.phases', {
    total,
    phases: PHASE_ORDER.map((key) => `${key} ${phases[key]}`).join(' · '),
    slowest,
  });
}

const PROOF_ORDER = ['tenant', 'crash', 'scale'] as const satisfies readonly (keyof ProofMs)[];

/** How many records the slowest-proof lines name: the head of the list is where the time went. */
export const SLOWEST_SHOWN = 5;

/** The records whose one proof took longest, slowest first: `slowest: job x · crash 9000 ms`. */
export function slowestProofLines(records: readonly ExerciseRecord[]): readonly string[] {
  const proofs = records.flatMap((record) => {
    const top = PROOF_ORDER.map((proof) => [proof, record.proofMs?.[proof] ?? 0] as const).reduce(
      (best, one) => (one[1] > best[1] ? one : best),
    );
    return top[1] > 0 ? [{ record, proof: top[0], ms: top[1] }] : [];
  });
  return proofs
    .toSorted((left, right) => right.ms - left.ms)
    .slice(0, SLOWEST_SHOWN)
    .map((one) =>
      msg('cli.exercise.slowest', {
        primitive: `${one.record.kind} ${one.record.name}`,
        proof: one.proof,
        ms: one.ms,
      }),
    );
}

const msOf = (value: number | undefined): string => (value === undefined ? '-' : String(value));

/** Unreached first — the rows that need a hand — then refused, off, reached; by name within. */
const RANK: readonly Outcome[] = ['unreached', 'refused', 'off', 'reached'];

export const renderExerciseTable = (records: readonly ExerciseRecord[]): readonly string[] =>
  renderTable(
    [
      'primitive',
      'kind',
      'outcome',
      'tenant',
      'crash',
      'code',
      'statements',
      'effects',
      'ms',
      'tenant ms',
      'crash ms',
      'scale ms',
    ],
    records
      .toSorted(
        (left, right) =>
          RANK.indexOf(left.outcome) - RANK.indexOf(right.outcome) ||
          left.name.localeCompare(right.name),
      )
      .map((one) => [
        one.name,
        one.kind,
        one.outcome,
        one.tenant?.verdict ?? '-',
        one.crash?.verdict ?? '-',
        one.code ?? '-',
        String(one.statements),
        String(one.effects.length),
        String(one.ms),
        msOf(one.proofMs?.tenant),
        msOf(one.proofMs?.crash),
        msOf(one.proofMs?.scale),
      ]),
  );
