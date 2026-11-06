// Single responsibility: the views half of `diffDeclaredSchema` — what the entities declare as
// `entity({ view })` against the views the newest migration's snapshot recorded. A view is
// recorded as the statements `x db gen` wrote for it, so equal statements are the whole agreement.

import type { ViewDescription } from '@ultimat3/db';
import type { SchemaDifference } from './schema-diff';

const DECLARED_ONLY = 'is declared by the entities and no migration recorded it';
const RECORDED_ONLY = 'was recorded by the newest migration and no entity declares it';
const STATEMENTS_MOVED = 'is declared with a query or index the newest migration did not record';

const kindOf = (view: ViewDescription): string =>
  view.materialized === true ? 'materialized' : 'a plain view';

function viewDetail(declared: ViewDescription, recorded: ViewDescription): string | undefined {
  if ((declared.materialized === true) !== (recorded.materialized === true)) {
    return `is declared ${kindOf(declared)} and was recorded ${kindOf(recorded)}`;
  }
  const same =
    declared.create.length === recorded.create.length &&
    declared.create.every((statement, at) => statement === recorded.create[at]);
  return same ? undefined : STATEMENTS_MOVED;
}

/**
 * Both directions, by name. Absent `views` is "none recorded": every snapshot written before views
 * existed, which is agreement with an app that declares none. A changed view is `unmigrated`, as a
 * changed column is — the declaration is the intent, and `x db gen` rebuilds every view from it.
 */
export function diffViews(
  declared: readonly ViewDescription[] = [],
  recorded: readonly ViewDescription[] = [],
): readonly SchemaDifference[] {
  const out: SchemaDifference[] = [];
  const byName = new Map(recorded.map((view) => [view.name, view]));
  for (const view of declared) {
    const counterpart = byName.get(view.name);
    const detail = counterpart === undefined ? DECLARED_ONLY : viewDetail(view, counterpart);
    if (detail === undefined) continue;
    out.push({ direction: 'unmigrated', part: 'view', table: view.name, name: view.name, detail });
  }
  const names = new Set(declared.map((view) => view.name));
  for (const view of recorded) {
    if (names.has(view.name)) continue;
    out.push({
      direction: 'undeclared',
      part: 'view',
      table: view.name,
      name: view.name,
      detail: RECORDED_ONLY,
    });
  }
  return out;
}
