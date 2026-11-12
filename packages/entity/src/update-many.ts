// Single responsibility: what an `updateMany([{ id, patch }])` batch is allowed to be, decided once
// in PROPERTY space so every driver writes the same thing — the patches through the one door, the
// column set they share, the scope they run under — and the in-memory judgement of the whole batch.
// The SQL is `pg-update-many-sql.ts`'s; sending it is `update-many-send.ts`'s.

import { keyOf } from './batch-read';
import { columnFor } from './column';
import { valueAt } from './cursor';
import type { EntityCore } from './entity';
import { EntityError, patchEmpty } from './errors';
import { assertedRowsTooMany, hasJsOnlyInvariant, MAX_ASSERTED_ROWS } from './invariants';
import { uniqueIndex, uniqueViolation } from './memory-unique';
import { mergedRow } from './memory-update';
import { readPlan, singleKeyOf } from './plan';
import type { RepoOptions, UpdateManyRow } from './repo';
import { assertRowTenant, type QueryPlan } from './tenancy';
import type { RowPatch } from './types';
import { assertVersionedUpdate } from './version-lock';

/** A batch, judged and resolved. Property names, so every driver reads one answer. */
export interface UpdateManyPlan<Row> {
  readonly op: 'updateMany';
  /** The primary key property each `id` addresses. */
  readonly key: string;
  /** Every property the patches write — the same set in every one, in declaration order. */
  readonly properties: readonly string[];
  /** The patches, parsed. Empty means there is nothing to send. */
  readonly patches: readonly { readonly id: string; readonly patch: RowPatch<Row> }[];
  /** The rows any write may touch: the tenant's, as every read is. No id predicate. */
  readonly scope: QueryPlan;
  /** `scope` plus `key in ids` — for a driver that selects the rows by plan before writing. */
  readonly match: QueryPlan;
}

const OP = 'updateMany';

/**
 * A row with no id addresses nothing, and `String(undefined)` would address a row keyed
 * "undefined". Refused as the empty filter is (`X_WRITE_UNFILTERED`): the id IS this write's filter.
 */
const unaddressed = (entityName: string, position: number): EntityError =>
  new EntityError({
    code: 'X_WRITE_UNFILTERED',
    cause: `${entityName}.updateMany() row ${position + 1} names no id — a nullish id addresses no row, and is never written as the text "undefined" or "null"`,
    fix: `${entityName}.updateMany(rows.filter((row) => row.id != null))   # or patch by filter: ${entityName}.where({ … }).updateAll(patch)`,
  });

/** Present and not `undefined`: `bindValues` binds nothing for an `undefined`, nor does memory. */
const writes = (patch: unknown, property: string): boolean =>
  typeof patch === 'object' &&
  patch !== null &&
  Object.hasOwn(patch, property) &&
  (patch as Readonly<Record<string, unknown>>)[property] !== undefined;

/**
 * One statement sets one column list, so a row that omits a column another row names would have
 * it set to something — and nothing the row said. Refused, as `upsertAll` refuses the same batch.
 */
const unevenBatch = (entityName: string, position: number, missing: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.updateMany() row ${position + 1} does not name "${missing}", which other rows of the batch do — one statement writes one column list to every row it updates`,
    fix: `${entityName}.updateMany(rows.map(({ id, patch }) => ({ id, patch: { ...patch, ${missing}: <value> } })))   # or one updateMany() per column set`,
  });

/** `update … from` meets a target row twice and keeps one of the two, unsaid which. */
const repeatedId = (entityName: string, position: number): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.updateMany() row ${position + 1} addresses an id already in the batch — one statement cannot update the same row twice`,
    fix: `${entityName}.updateMany([...new Map(rows.map((row) => [row.id, row])).values()])   # dedupe on id: the last patch per id wins`,
  });

/** The batch's column set, refusing a row that names a different one. */
const sharedProperties = <Row>(
  entity: EntityCore<Row>,
  patches: readonly RowPatch<Row>[],
): readonly string[] => {
  const properties = Object.keys(entity.$columns).filter((property) =>
    patches.some((patch) => writes(patch, property)),
  );
  for (const [position, patch] of patches.entries()) {
    const missing = properties.find((property) => !writes(patch, property));
    if (missing !== undefined) throw unevenBatch(entity.$name, position, missing);
  }
  return properties;
};

/**
 * The batch, judged before any driver sees it. Each patch goes through `$parsePatch` (the door
 * `update(id, patch)` uses) and the tenant check a patch gets (a patch naming another tenant
 * would hand its row away). An app-only rule reads every row back to be judged, so a batch
 * wider than `MAX_ASSERTED_ROWS` is refused here, before a statement exists — as `updateWhere`.
 */
export const updateManyPlan = <Row>(
  entity: EntityCore<Row>,
  rows: readonly UpdateManyRow<Row>[],
  options: RepoOptions | undefined,
): UpdateManyPlan<Row> => {
  const key = singleKeyOf(entity, OP);
  const kind = columnFor(entity.$columns, key)?.$meta.kind ?? '';
  for (const [position, row] of rows.entries()) {
    if (row.id === undefined || row.id === null) throw unaddressed(entity.$name, position);
  }
  const patches = rows.map((row) => ({ id: String(row.id), patch: entity.$parsePatch(row.patch) }));
  for (const { patch } of patches) {
    assertRowTenant(entity.$name, entity.$tenantColumn, OP, patch);
    // A declared lock: every row names the version it was read at, as `update(id, patch)` does.
    assertVersionedUpdate(entity, patch, OP);
  }
  const properties = sharedProperties(
    entity,
    patches.map((each) => each.patch),
  );
  if (patches.length > 0 && properties.length === 0) {
    throw patchEmpty(entity.$name, OP, Object.keys(entity.$columns));
  }
  const seen = new Set<string>();
  for (const [position, { id }] of patches.entries()) {
    const spelled = keyOf(kind, id);
    if (seen.has(spelled)) throw repeatedId(entity.$name, position);
    seen.add(spelled);
  }
  if (hasJsOnlyInvariant(entity.$invariants) && patches.length > MAX_ASSERTED_ROWS) {
    throw assertedRowsTooMany(entity.$name, OP, patches.length);
  }
  const ids = patches.map((each) => each.id);
  return {
    op: OP,
    key,
    properties,
    patches,
    scope: readPlan(entity, { ...options, where: [] }, OP),
    match: readPlan(entity, { ...options, where: [{ column: key, op: 'in', value: ids }] }, OP),
  };
};

/**
 * The rows a batch makes of the stored rows it matched, judged as ONE batch before any lands —
 * `judgeUpdate`'s four judgements (tenant, invariants, primary key, unique constraints), with one
 * patch per row instead of one for all. `matched` are the live rows `plan.match` selects;
 * `untouched` every other stored row, another tenant's and the soft-deleted ones included, because
 * a Postgres unique index covers those too. `key` is the store's own row key.
 */
export const judgeUpdateMany = <Row>(
  entity: EntityCore<Row>,
  plan: UpdateManyPlan<Row>,
  matched: readonly Row[],
  untouched: readonly Row[],
  key: (row: unknown) => string,
): readonly Row[] => {
  const kind = columnFor(entity.$columns, plan.key)?.$meta.kind ?? '';
  const patchFor = new Map(plan.patches.map((each) => [keyOf(kind, each.id), each.patch]));
  const untouchedKeys = new Set(untouched.map((row) => key(row)));
  const judgedKeys = new Set<string>();
  const taken = uniqueIndex(entity, untouched);
  const judged: Row[] = [];
  for (const row of matched) {
    const patch = patchFor.get(keyOf(kind, valueAt(row, plan.key)));
    if (patch === undefined) continue;
    const result = mergedRow(entity, row, patch);
    assertRowTenant(entity.$name, entity.$tenantColumn, OP, result);
    entity.$assert(result);
    const resultKey = key(result);
    if (untouchedKeys.has(resultKey) || judgedKeys.has(resultKey)) {
      throw uniqueViolation(entity, `${entity.$table}_pkey`);
    }
    const clash = taken.clash(result);
    if (clash !== undefined) throw uniqueViolation(entity, clash);
    taken.add(result);
    judged.push(result);
    judgedKeys.add(resultKey);
  }
  return judged;
};
