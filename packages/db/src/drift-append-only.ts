// Single responsibility: whether an `appendOnly` table still carries the trigger that refuses UPDATE
// and DELETE, and what to say when it does not. The repository refuses above the driver whatever
// the database holds, so a dropped trigger is invisible to every test — only the catalog can say.

import { byHand, type DriftDifference, pathTo, repair } from './drift-findings';
import {
  APPEND_ONLY_FUNCTION_SQL,
  APPEND_ONLY_TRIGGER,
  installAppendOnlyTriggerSql,
} from './generate-append-only';
import type { TableDescription } from './introspect';
import { shellInertIdentifier } from './sql';

/** The code `driftError` raises for this kind, exported so the tests assert the one literal. */
export const APPEND_ONLY_DRIFT_CODE = 'X_APPEND_ONLY_TRIGGER_MISSING';

/**
 * The constructor. The fix is the two statements `x db gen` wrote, run against THIS database:
 * the migration that added the trigger is already in the ledger, so `x db migrate` applies nothing
 * (`repair`'s argument). Drop-if-exists before create, because a DISABLED trigger counts as missing
 * here yet still exists, and a bare `create trigger` would fail on it. The function is redefined too — `create or replace` — because a hand that
 * dropped the trigger may have dropped the function with it.
 */
export function missingAppendOnlyTrigger(schema: string, table: string): DriftDifference {
  const path = pathTo(schema);
  const spellable = shellInertIdentifier(table) !== null;
  return {
    kind: 'missing-append-only-trigger',
    table,
    column: null,
    cause:
      `table "${table}" is declared appendOnly, and its trigger ${APPEND_ONLY_TRIGGER} is missing ` +
      'or disabled — raw SQL can UPDATE and DELETE its rows; only the repository still refuses',
    fix:
      path === null || !spellable
        ? byHand('re-create the append-only function and trigger this difference names')
        : repair(path, [APPEND_ONLY_FUNCTION_SQL, ...installAppendOnlyTriggerSql(table)].join(' ')),
  };
}

/**
 * Judged only where both halves were asked: the snapshot declares the table append-only AND the
 * catalog was read (`triggerNames` present). Either absent says nothing — a sidecar that predates
 * the field, or a description nobody introspected — exactly as `compareChecks` reads its pair.
 */
export function compareAppendOnly(
  live: TableDescription,
  expected: TableDescription,
): DriftDifference[] {
  if (expected.appendOnly !== true || live.triggerNames === undefined) return [];
  if (live.triggerNames.includes(APPEND_ONLY_TRIGGER)) return [];
  return [missingAppendOnlyTrigger(live.schema, live.name)];
}
