// Single responsibility: one parent key's write, for a table whose `<table>_history` the subject
// deletes, or whose delete the database carries into a child that keeps one. The write is made,
// then every history row whose before or after image names that key removed — in ONE transaction
// under `x.purge`, because the write's own trigger (and an `on delete set null | cascade` child's)
// has just recorded the person's data in one more image, and a replay must find all of it or none.
//
// Matched by the IMAGE, never by the live rows' ids: a row deleted or soft-deleted before the
// erase, or inserted after an id read, left images naming the subject all the same. Cost: the
// predicate is `before @> {key} or after @> {key}` within the tenant — no index serves it (the
// history index is tenant, row_id, at), so it reads the tenant's history once per key and image.
// Erase is rare; an app with a large trail adds a GIN `jsonb_path_ops` index on `before`/`after`.

import type { SubjectOrphan, SubjectStep } from './subject-plan';
import type { SubjectReader, SubjectTable } from './subject-select';

/** What one page of parent keys did: the table's rows written, and each history's rows removed. */
export interface HistoryPage {
  readonly treated: number;
  readonly history: Readonly<Record<string, number>>;
}

/** Every history row whose before or after image names `value` in `property`. */
async function purgeImages(
  reader: SubjectReader,
  history: string,
  property: string,
  value: unknown,
): Promise<number> {
  let removed = 0;
  // Sequential: a row naming the key in both images goes with the first and is counted once.
  for (const images of reader.imagesNaming(history, property, value)) {
    removed += await images.deleteAll();
  }
  return removed;
}

/** `parentKey` on the rows `property = value` is about to delete: what an orphan's image names. */
async function keysOf(
  reader: SubjectReader,
  table: SubjectTable,
  property: string,
  value: unknown,
  parentKey: string,
): Promise<readonly unknown[]> {
  if (property === parentKey) return [value];
  const keys = new Set<unknown>();
  for await (const page of table.andWhere(property, 'eq', value).inBatches(reader.size)) {
    for (const row of page) keys.add(row[parentKey]);
  }
  keys.delete(null);
  keys.delete(undefined);
  return [...keys];
}

export async function treatPageWithHistory(
  reader: SubjectReader,
  step: SubjectStep,
  property: string,
  values: readonly unknown[],
): Promise<HistoryPage> {
  const table = reader.table(step.entity);
  const anonymize =
    typeof step.treatment === 'object' && 'anonymize' in step.treatment
      ? step.treatment.anonymize
      : undefined;
  const orphans: readonly SubjectOrphan[] = step.orphans ?? [];
  const first = step.history ?? orphans[0]?.history;
  const history: Record<string, number> = {};
  const add = (name: string, n: number): void => {
    history[name] = (history[name] ?? 0) + n;
  };
  let treated = 0;
  if (first === undefined) return { treated, history };
  for (const value of values) {
    const filter = { [property]: value };
    // Postgres: `purging` set `x.purge` in this transaction, which the guard trigger reads; memory:
    // `purgingHistory` opened the history repository to this one table's deletes. A nested
    // `purging` names the next table: own history first, so `x.purge` moves only forward.
    treated += await reader.purging(first, async () => {
      const named = new Map<string, readonly unknown[]>();
      for (const orphan of orphans) {
        if (!named.has(orphan.parentKey)) {
          named.set(
            orphan.parentKey,
            await keysOf(reader, table, property, value, orphan.parentKey),
          );
        }
      }
      const written =
        step.treatment === 'delete'
          ? await table.deleteWhere(filter)
          : anonymize === undefined
            ? 0
            : await table.updateWhere(filter, anonymize);
      if (step.history !== undefined) {
        add(step.history, await purgeImages(reader, step.history, property, value));
      }
      for (const orphan of orphans) {
        const removed = await reader.purging(orphan.history, async () => {
          let n = 0;
          for (const key of named.get(orphan.parentKey) ?? []) {
            n += await purgeImages(reader, orphan.history, orphan.property, key);
          }
          return n;
        });
        add(orphan.history, removed);
      }
      return written;
    });
  }
  return { treated, history };
}
