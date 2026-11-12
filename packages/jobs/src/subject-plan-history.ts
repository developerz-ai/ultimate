// Single responsibility: which `<table>_history` tables a subject's erase reaches, and how. Reached
// exactly when its parent is deleted or anonymized; `'delete'` rides the parent's step, after it.
// Its ROWS are found by image, never by `row_id` (`imagesNaming`, `subject-select.ts`).
//
// Why a table of its own: a history row names its parent by `row_id`, which is no foreign key — so
// the walk never finds it — and every write the erase makes to the parent records the person's data
// in a before image.

import type { UltimateError } from '@ultimat3/core';
import type { RegistryEntry } from '@ultimat3/entity';
import type { SubjectTreatment } from './subject';
import { SubjectTableUndeclaredError } from './subject-errors';
import type { SubjectVia } from './subject-plan';

/** The column a history row names its parent row by (`historyEntity`'s `rowId`). */
const ROW_ID = 'rowId';

export interface HistoryReach {
  /** Parent → its history table, deleted inside the parent's own step. */
  readonly deletedWith: ReadonlyMap<string, string>;
  /**
   * History tables kept, each a step of its own run before its parent. `via` (`rowId` → parent)
   * names the parent and orders the step; the rows counted are those whose images name the
   * subject, by the parent's own reach — so a parent row deleted before the erase still counts.
   */
  readonly retained: ReadonlyMap<string, { readonly parent: string; readonly via: SubjectVia }>;
  /** Every history table the erase reaches, whatever its treatment: none is a stray declaration. */
  readonly reached: ReadonlySet<string>;
  readonly problems: readonly UltimateError[];
}

const writes = (treatment: SubjectTreatment | undefined): boolean =>
  treatment === 'delete' ||
  (typeof treatment === 'object' && treatment !== null && 'anonymize' in treatment);

export function historyReach(input: {
  readonly subject: string;
  readonly byName: ReadonlyMap<string, RegistryEntry>;
  /** Whether the walk reached the entity at all. */
  readonly reached: (entity: string) => boolean;
  readonly treatmentOf: (entity: string) => SubjectTreatment | undefined;
}): HistoryReach {
  const deletedWith = new Map<string, string>();
  const retained = new Map<string, { readonly parent: string; readonly via: SubjectVia }>();
  const problems: UltimateError[] = [];
  const reached = new Set<string>();
  for (const entry of input.byName.values()) {
    const parent = entry.describe().historyOf;
    if (parent === undefined || !input.reached(parent)) continue;
    if (!writes(input.treatmentOf(parent))) continue;
    reached.add(entry.name);
    const treatment = input.treatmentOf(entry.name);
    if (treatment === undefined) {
      const path = [input.subject, parent, `${entry.name}.${ROW_ID}`];
      problems.push(
        new SubjectTableUndeclaredError({ subject: input.subject, table: entry.name, path }),
      );
      continue;
    }
    if (treatment === 'delete') {
      deletedWith.set(parent, entry.name);
      continue;
    }
    if (typeof treatment === 'object' && treatment !== null && 'retain' in treatment) {
      const key = input.byName
        .get(parent)
        ?.describe()
        .columns.find((c) => c.primaryKey);
      const via = { property: ROW_ID, parent, parentKey: key?.property ?? 'id' };
      retained.set(entry.name, { parent, via });
    }
    // `anonymize` is refused per treatment (`subject-plan.ts`): history is never rewritten.
  }
  return { deletedWith, retained, reached, problems };
}
