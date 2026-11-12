// Single responsibility: one parent key's write, for a table whose `<table>_history` the subject
// deletes. The rows' ids are read first, the write made, then every history row of those ids
// removed — in ONE transaction under `x.purge`, because the write's own trigger has just recorded
// the person's data in one more image, and a replayed step must find all three done or none.

import { identifier, sql } from '@ultimat3/db';
import type { SubjectStep } from './subject-plan';
import type { SubjectReader, SubjectRow } from './subject-select';

/** What one page of parent keys did: the table's rows written, and its history rows removed. */
export interface HistoryPage {
  readonly treated: number;
  readonly history: number;
}

/** The physical column a history row names its parent row by (`generate-history.ts`). */
const ROW_ID = identifier('row_id');

export async function treatPageWithHistory(
  reader: SubjectReader,
  step: SubjectStep & { readonly history: string },
  property: string,
  values: readonly unknown[],
): Promise<HistoryPage> {
  const table = reader.table(step.entity);
  const trail = identifier(reader.core(step.history).$table);
  const key = reader.core(step.entity).$primaryKey[0] ?? 'id';
  const anonymize =
    typeof step.treatment === 'object' && 'anonymize' in step.treatment
      ? step.treatment.anonymize
      : undefined;
  let treated = 0;
  let history = 0;
  for (const value of values) {
    const filter = { [property]: value };
    const done = await reader.purging(step.history, async (tx) => {
      const ids: string[] = [];
      for await (const page of table.where(filter).inBatches(reader.size)) {
        ids.push(...page.map((row: SubjectRow) => String(row[key])));
      }
      const written =
        step.treatment === 'delete'
          ? await table.deleteWhere(filter)
          : anonymize === undefined
            ? 0
            : await table.updateWhere(filter, anonymize);
      // SQL on a database (only the guard trigger knows `x.purge`); in memory, the history
      // repository itself, which `purging` opened to this one delete (`purgingHistory`).
      let removed = 0;
      for (let at = 0; at < ids.length; at += reader.size) {
        const chunk = ids.slice(at, at + reader.size);
        removed +=
          tx === undefined
            ? await reader.table(step.history).andWhere('rowId', 'in', chunk).deleteAll()
            : await tx.execute(sql`delete from ${trail} where ${ROW_ID} = any(${chunk}::text[])`);
      }
      return { written, removed };
    });
    treated += done.written;
    history += done.removed;
  }
  return { treated, history };
}
