// The whole `exercise` floor verdict, one function for `x exercise` and the gate step alike: the
// unproven ratio (`exercise-floor.ts`), the sized-seed failures that explain it, and the statement
// ceiling. Each is red only where `x.verify.json`'s `exercise` key opted in; otherwise a warning,
// so an app that has not opted in stays green on `main` (X_BREAKING_ON_MAIN).

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { ExerciseRecord } from '@ultimat3/testing';
import { STATEMENTS_MAX, scaleSeedFindings, statementCeilingFindings } from '@ultimat3/testing';
import type { ExerciseFloor } from './exercise-floor';
import { judgeUnproven } from './exercise-floor';
import type { Finding } from './output';

/** What the verdict reads of a record: who it is and its three proofs. */
export type FloorRecord = Pick<
  ExerciseRecord,
  'kind' | 'name' | 'outcome' | 'tenant' | 'crash' | 'scale' | 'statementCeiling'
>;

/** The codes this verdict owns: the gate drops the child's copies and states its own. */
export const FLOOR_CODES: ReadonlySet<string> = new Set([
  'X_EXERCISE_UNPROVEN_ABOVE_FLOOR',
  'X_EXERCISE_SEED_FAILED',
  'X_STATEMENTS_OVER_BUDGET',
]);

export interface FloorVerdict {
  readonly findings: readonly Finding[];
  readonly warnings: readonly string[];
}

/** A finding a floor did not opt into, as the one warning line a gate prints for it. */
const asWarning = (finding: Omit<Finding, 'docs'>): string =>
  `${finding.code} ${finding.cause} — fix: ${finding.fix}`;

/**
 * `statementsMax` replaces the default ceiling for every primitive whose entry declared none; an
 * entry's own `statements: { max, why }` stands. The pass judged against `STATEMENTS_MAX`, so the
 * floor re-judges from the counts it recorded.
 */
const rejudged = (records: readonly FloorRecord[], max: number): readonly FloorRecord[] =>
  records.map((record) => {
    const proof = record.statementCeiling;
    if (proof === undefined || (proof.verdict === 'over' && proof.why !== undefined)) return record;
    if (proof.verdict === 'within' && proof.max !== STATEMENTS_MAX) return record;
    if (proof.statements <= max) {
      return {
        ...record,
        statementCeiling: { verdict: 'within', statements: proof.statements, max },
      };
    }
    const top = proof.verdict === 'over' ? proof.top : [];
    return {
      ...record,
      statementCeiling: { verdict: 'over', statements: proof.statements, max, top },
    };
  });

/** The figure `x upgrade` writes: the busiest undeclared call, never under the default. */
export function measuredStatementsMax(records: readonly FloorRecord[]): number {
  return records.reduce((top, record) => {
    const proof = record.statementCeiling;
    if (proof === undefined) return top;
    const declared =
      proof.verdict === 'over' ? proof.why !== undefined : proof.max !== STATEMENTS_MAX;
    return declared ? top : Math.max(top, proof.statements);
  }, STATEMENTS_MAX);
}

export function exerciseFloorVerdict(
  records: readonly FloorRecord[],
  floor: ExerciseFloor | undefined,
): FloorVerdict {
  const unproven = judgeUnproven(records, floor);
  const seeds = scaleSeedFindings(records);
  // A seed failure is the reason behind an unproven ratio: red exactly when that ratio is.
  const seedRed = unproven.findings.length > 0;
  const max = floor?.statementsMax;
  const statements = statementCeilingFindings(max === undefined ? records : rejudged(records, max));
  const docs = (finding: Omit<Finding, 'docs'>): Finding => ({ ...finding, docs: ERROR_DOCS_URL });
  return {
    findings: [
      ...unproven.findings,
      ...(seedRed ? seeds.map(docs) : []),
      ...(max === undefined ? [] : statements.map(docs)),
    ],
    warnings: [
      ...unproven.warnings,
      ...(seedRed ? [] : seeds.map(asWarning)),
      ...(max === undefined ? statements.map(asWarning) : []),
    ],
  };
}
