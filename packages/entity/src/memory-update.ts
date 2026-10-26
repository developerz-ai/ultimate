// Single responsibility: the memory driver's UPDATE — the merge of a patch into a row, and the
// judgement of a filtered update's whole result before any of it lands.
//
// Postgres refuses such a write as ONE statement: the rows come back from `update … returning *`,
// the app judges them, and a rule only the app can judge refuses the statement, so the
// transaction holding both takes the write with it (`judged-write.ts`). The in-memory driver wrote
// row by row, so a row refused half way through left the rows before it stored: one call, two
// answers — a test over the memory driver saw a partial write, and production rolled it back.

import { narrowRow } from './columns';
import type { EntityCore } from './entity';
import { uniqueClash, uniqueViolation } from './memory-unique';
import { assertRowTenant } from './tenancy';

/**
 * The patch with every `undefined` property dropped — `bindValues` skips them in Postgres, so a
 * patch built from optional input (`{ body: input.body }`) leaves the column alone in both drivers
 * rather than erasing it. `null` is the value that clears a column.
 */
const defined = (patch: object): object =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));

/**
 * The row a patch makes of a stored one: the patch's values over the row's own, narrowed to what
 * the store holds.
 *
 * Narrowed HERE, at the merge, because `$assert` judges the merged row and a money column's
 * `bigint` minor unit has to be the `number` the row will hold. `insertAll` narrows twice for the
 * same reason (`memory-repo.ts`), and narrowing twice is harmless: the second pass finds nothing
 * left to change.
 */
export const mergedRow = <Row>(entity: EntityCore<Row>, row: Row, patch: object): Row =>
  narrowRow<Row>(entity.$columns, Object.assign({}, row, defined(patch)));

/**
 * The rows a filtered update would write, judged as ONE batch: the patch merged into every
 * matched row, and every result judged against the rows this write does not touch and against the
 * results this same batch has already judged.
 *
 * `untouched` are the stored rows the filter did not match — including the rows of another tenant
 * and the soft-deleted ones, because the unique index in Postgres covers those too. `key` is the
 * key the store files a row under, handed in because that is the store's rule and this module must
 * not spell it a second time.
 *
 * The judgement is the whole batch's, so a refusal lands before anything is stored — the shape
 * `insertAll` already has, and the shape Postgres gives the statement it refuses.
 */
export const judgeUpdate = <Row>(
  entity: EntityCore<Row>,
  matched: readonly Row[],
  patch: object,
  untouched: readonly Row[],
  key: (row: unknown) => string,
): readonly Row[] => {
  const judged: Row[] = [];
  const judgedKeys = new Set<string>();
  const untouchedKeys = new Set(untouched.map((row) => key(row)));
  for (const row of matched) {
    const result = mergedRow(entity, row, patch);
    // The same four judgements `write` makes, in the same order — on the merged row rather than
    // on the patch, and on the whole batch rather than on the row that happens to come first.
    assertRowTenant(entity.$name, entity.$tenantColumn, 'updateWhere', result);
    entity.$assert(result);
    // The primary key: a result may not land on a key another row holds — neither one this write
    // does not touch, nor one an earlier result of this same batch took. A row's OWN old version
    // is not among them: it is the row this result replaces, and it never collides with itself.
    const resultKey = key(result);
    if (untouchedKeys.has(resultKey) || judgedKeys.has(resultKey)) {
      throw uniqueViolation(entity, `${entity.$table}_pkey`);
    }
    // The unique constraints, against the same two sets. The rows this batch matched are not in
    // either: each of them is replaced by its own result, which is judged here instead.
    const clash = uniqueClash(entity, result, [...untouched, ...judged]);
    if (clash !== undefined) throw uniqueViolation(entity, clash);
    judged.push(result);
    judgedKeys.add(resultKey);
  }
  return judged;
};
