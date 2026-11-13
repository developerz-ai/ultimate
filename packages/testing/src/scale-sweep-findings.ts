// The scale sweep's own failure, as `x exercise` reports it: one `X_EXERCISE_SEED_FAILED` per table
// the sized seed could not write, naming the entity, the driver's words and every primitive whose
// scale proof it left `unproven` — never one unexplained `unproven` per primitive.

import { renderCauseValue, renderFixLiteral } from '@ultimat3/core';
import type { ScaleProof } from './scale-sweep';
import type { ScaleSeedFailure } from './scale-sweep-seed';

/** What a finding needs of a record: who it is and its scale proof. */
interface ScaleRecord {
  readonly kind: string;
  readonly name: string;
  readonly scale?: ScaleProof;
}

export interface ScaleSeedFinding {
  readonly code: 'X_EXERCISE_SEED_FAILED';
  readonly cause: string;
  readonly fix: string;
  readonly at: string;
}

const MAX_NAMED = 10;

/** One finding per failed table, in the order the readers' records list them. */
export function scaleSeedFindings(records: readonly ScaleRecord[]): readonly ScaleSeedFinding[] {
  const groups = new Map<string, { failure: ScaleSeedFailure; readers: string[] }>();
  for (const record of records) {
    const failure = record.scale?.verdict === 'unproven' ? record.scale.seed : undefined;
    if (failure === undefined) continue;
    const group = groups.get(failure.entity) ?? { failure, readers: [] };
    group.readers.push(`${record.kind} ${record.name}`);
    groups.set(failure.entity, group);
  }
  return [...groups.values()].map(({ failure, readers }) => {
    const named = readers.slice(0, MAX_NAMED).join(', ');
    const more = readers.length > MAX_NAMED ? ` and ${readers.length - MAX_NAMED} more` : '';
    const entity = renderFixLiteral(failure.entity, '<entity>');
    return {
      code: 'X_EXERCISE_SEED_FAILED',
      cause: `the scale sweep could not write the sized rows of ${renderCauseValue(failure.entity)} (${renderCauseValue(failure.cause)}), so ${readers.length} primitive(s) reading it are unproven: ${named}${more}`,
      fix: `defineExercise({}, { factories: { ${entity}: defineFactory(<the ${failure.entity} entity>, { defaults: (index) => ({ /* each constrained column, distinct per index */ }) }) } })   # in apps/web/exercise.ts, then: x exercise --json`,
      at: 'apps/web/exercise.ts',
    };
  });
}
