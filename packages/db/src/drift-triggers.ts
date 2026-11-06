// Single responsibility: whether the lifecycle triggers a migration installed — history, its guard,
// counters — are still enabled on the table, and whether a `retain` table became partitioned. The
// repository never sees either, so only the catalog can say. `drift-append-only.ts` is the model.

import { byHand, type DriftDifference, pathTo, repair } from './drift-findings';
import type { TableDescription, TriggerRecord } from './introspect';
import { shellInertIdentifier } from './sql';

/** The codes `driftError` raises for these kinds, exported so the tests assert the one literal. */
export const LIFECYCLE_DRIFT_CODE = 'X_LIFECYCLE_TRIGGER_MISSING';
export const RETAIN_DRIFT_CODE = 'X_ENTITY_RETAIN_INVALID';

/** The fix is the statements `x db gen` wrote, against THIS database: the ledger already holds them. */
function missingTrigger(live: TableDescription, trigger: TriggerRecord): DriftDifference {
  const path = pathTo(live.schema);
  return {
    kind: 'missing-lifecycle-trigger',
    table: live.name,
    column: null,
    cause:
      `table "${live.name}" was given trigger ${trigger.name} by a migration, and it is missing or ` +
      'disabled — writes here no longer record history or keep a counter',
    fix:
      path === null || shellInertIdentifier(live.name) === null
        ? byHand(`re-create trigger ${trigger.name} as the newest migration that names it does`)
        : repair(path, trigger.install.join(' ')),
  };
}

function partitionedRetain(live: TableDescription): DriftDifference {
  return {
    kind: 'retain-partitioned',
    table: live.name,
    column: null,
    cause:
      `table "${live.name}" declares retain and the catalog holds it partitioned: a partitioned ` +
      "table's retention is detaching its old partitions, never a row-by-row sweep",
    fix: `x db gen "drop retain"   # after removing retain from the entity on ${live.name}; detach old partitions in a task`,
  };
}

/** Judged only where both halves were asked, exactly as `compareAppendOnly` reads its pair. */
export function compareTriggers(
  live: TableDescription,
  expected: TableDescription,
): DriftDifference[] {
  const out: DriftDifference[] = [];
  if (expected.retain === true && live.partitioned === true) out.push(partitionedRetain(live));
  if (live.triggerNames === undefined) return out;
  for (const trigger of expected.triggers ?? []) {
    if (!live.triggerNames.includes(trigger.name)) out.push(missingTrigger(live, trigger));
  }
  return out;
}
