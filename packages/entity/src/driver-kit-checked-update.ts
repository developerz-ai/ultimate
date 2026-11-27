// Single responsibility: a `defineDriver` JUDGED update of an unversioned entity — read the rows,
// judge every merged row, then write — with the write conditioned on the rows still being the ones
// judged when the store offers `updateChecked`. A lost set is another writer's progress: re-read,
// re-judge, retry, bounded; a store without it keeps the unconditional `update` (#1379).

import { driverError, SQLSTATE } from '@ultimat3/db';
import type { DriverAdvance } from './driver-kit-types';
import type { DriverScope } from './driver-scope';
import { assertedRowsTooMany, MAX_ASSERTED_ROWS } from './invariants';
import { mergedRow } from './memory-update';
import { namedColumns } from './plan';
import type { Tx } from './repo';
import { assertRowTenant, type QueryPlan } from './tenancy';

/**
 * How many times a judged update re-reads a set a concurrent writer keeps moving. Each lost set is
 * another writer's progress; the bound only stops a store whose compare never matches.
 */
export const MAX_CHECKED_RETRIES = 16;

export interface CheckedUpdate<Row> {
  readonly op: string;
  readonly plan: QueryPlan;
  readonly patch: object;
  readonly advance: DriverAdvance | undefined;
  readonly narrowed: Readonly<Record<string, unknown>>;
  readonly tx: Tx | undefined;
  /** Same-tenant references of the merged rows, judged as a batch. */
  readonly references: (rows: readonly Row[]) => Promise<void>;
}

/** What the write did: how many rows, and the rows as they were judged (for the search mirror). */
export interface CheckedResult<Row> {
  readonly written: number;
  readonly found: readonly Row[];
}

/** The lost race, as Postgres says it under serializable isolation: retryable, coded alike. */
const lostEveryRace = (table: string, attempts: number) =>
  driverError(`update ${table}`, {
    code: SQLSTATE.serializationFailure,
    message: `the rows this update judged changed before every one of ${attempts} conditioned writes — nothing was written; re-run the call`,
  });

export const checkedUpdate = async <Row>(
  scope: DriverScope<Row>,
  write: CheckedUpdate<Row>,
): Promise<CheckedResult<Row>> => {
  const { entity, raw } = scope;
  const { op, plan, patch, advance, narrowed, tx } = write;
  for (let attempt = 0; attempt <= MAX_CHECKED_RETRIES; attempt += 1) {
    // Every invariant, a SQL-expressible one too: a custom store enforces no CHECK.
    const read = await raw.select({ plan, after: undefined, limit: MAX_ASSERTED_ROWS + 1, tx });
    const found = scope.checked(op, plan, read);
    if (found.length > MAX_ASSERTED_ROWS) throw assertedRowsTooMany(entity.$name, op, found.length);
    const [first] = found;
    if (first === undefined) return { written: 0, found };
    const results = found.map((row) => mergedRow(entity, row, patch));
    for (const merged of results) {
      assertRowTenant(entity.$name, entity.$tenantColumn, op, merged);
      entity.$assert(merged);
    }
    await write.references(results);
    // The narrowed values the merge produced — the same for every row — so the store holds what
    // was judged rather than a money `bigint` the row type never carries. The version is the
    // patch's instant: the store advances it per row.
    const merged = mergedRow(entity, first, patch) as Record<string, unknown>;
    const values = Object.fromEntries(namedColumns(patch).map(([key]) => [key, merged[key]]));
    if (advance !== undefined) values[advance.property] = narrowed[advance.property];
    if (raw.updateChecked === undefined) {
      return { written: await raw.update({ plan, tx }, values, advance), found };
    }
    if (await raw.updateChecked({ plan, tx }, read, values, advance)) {
      return { written: found.length, found };
    }
  }
  throw lostEveryRace(entity.$table, MAX_CHECKED_RETRIES + 1);
};
