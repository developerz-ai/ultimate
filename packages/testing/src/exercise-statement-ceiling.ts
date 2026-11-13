// The absolute statement ceiling: one call of a primitive sends at most `STATEMENTS_MAX` statements
// unless its `defineExercise` entry raises or lowers it with `statements: { max, why }`. The scale
// sweep judges growth; this judges the count itself — a fixed 300-statement call is flat and slow.

import { finiteCount, renderCauseValue, renderFixLiteral, renderFixShellArg } from '@ultimat3/core';
import type { StatementTally } from './scale-sweep';

/** Statements one call may send when its entry declares no `statements`. */
export const STATEMENTS_MAX = 100;

/** `statements: { max: 140, why: 'imports one row per line, bounded by the 140-line form' }`. */
export interface ExerciseStatementCeiling {
  readonly max: number;
  readonly why: string;
}

/** One call's statements: the count and its shapes, as the room observed them. */
interface CallTally {
  readonly statements: number;
  readonly shapes: readonly StatementTally[];
}

/** A shape among the over-budget call's largest, by count. */
export interface CeilingShape {
  readonly fingerprint: string;
  readonly count: number;
}

/** The busiest call against the ceiling in force; `why` / `declared` when the entry declared it. */
export type StatementCeilingProof =
  | {
      readonly verdict: 'within';
      readonly statements: number;
      readonly max: number;
      /** The entry's own `statements` — at the default figure too, so no floor re-judges it. */
      readonly declared?: true;
    }
  | {
      readonly verdict: 'over';
      readonly statements: number;
      readonly max: number;
      /** The three shapes it sent most, largest first: what a `preload` would fold. */
      readonly top: readonly CeilingShape[];
      readonly why?: string;
    };

const TOP_SHAPES = 3;

/** The busiest of `calls` against `declared`, else `STATEMENTS_MAX`. No call: nothing to judge. */
export function judgeStatementCeiling(
  calls: readonly CallTally[],
  declared?: ExerciseStatementCeiling,
): StatementCeilingProof | undefined {
  const busiest = calls.reduce<CallTally | undefined>(
    (top, call) => (top === undefined || call.statements > top.statements ? call : top),
    undefined,
  );
  if (busiest === undefined) return undefined;
  // `defineExercise` screens a declared max; an override built by hand reaches here unscreened.
  const max = finiteCount('statements', 'max', declared?.max ?? STATEMENTS_MAX, 1);
  if (busiest.statements <= max) {
    return {
      verdict: 'within',
      statements: busiest.statements,
      max,
      ...(declared === undefined ? {} : { declared: true as const }),
    };
  }
  const top = [...busiest.shapes]
    .sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, TOP_SHAPES)
    .map(({ fingerprint, count }) => ({ fingerprint, count }));
  return {
    verdict: 'over',
    statements: busiest.statements,
    max,
    top,
    ...(declared === undefined ? {} : { why: declared.why }),
  };
}

/** What a finding needs of a record: who it is and its ceiling proof. */
interface CeilingRecord {
  readonly kind: string;
  readonly name: string;
  readonly statementCeiling?: StatementCeilingProof;
}

export interface StatementCeilingFinding {
  readonly code: 'X_STATEMENTS_OVER_BUDGET';
  readonly cause: string;
  readonly fix: string;
  readonly at: string;
}

/** One finding per primitive whose busiest call went over its ceiling, its top shapes named. */
export function statementCeilingFindings(
  records: readonly CeilingRecord[],
): readonly StatementCeilingFinding[] {
  return records.flatMap((record): StatementCeilingFinding[] => {
    const proof = record.statementCeiling;
    if (proof?.verdict !== 'over') return [];
    const shapes = proof.top.map((one) => `${one.fingerprint} ×${one.count}`).join(', ');
    const ceiling =
      proof.why === undefined
        ? `the default ceiling of ${proof.max}`
        : `its declared ceiling of ${proof.max} (${renderCauseValue(proof.why)})`;
    const name = renderFixShellArg(record.name, '<primitive>');
    const entry = renderFixLiteral(record.name, '<primitive>');
    return [
      {
        code: 'X_STATEMENTS_OVER_BUDGET',
        cause: `${record.kind} ${renderCauseValue(record.name)} sent ${proof.statements} statements in one call, over ${ceiling}; most sent: ${renderCauseValue(shapes)}`,
        // The edit first: the rerun before it re-sends the same count (`fix-sequence.ts`).
        fix: `defineExercise({ ${entry}: { statements: { max: ${proof.statements}, why: '<why one call needs them>' } } })   # in apps/web/exercise.ts, unless a preload() folds what the call reads row by row; then: x exercise ${name} --json`,
        at: `${record.kind} ${record.name}`,
      },
    ];
  });
}
