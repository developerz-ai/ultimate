// Single responsibility: write `updateMany`'s moved rows BACK after a refusal part way, on a custom
// store. With `updateChecked` a row is restored only while it still holds what this batch wrote: a
// newer write is never clobbered, and the batch is refused as torn. Without it, today's
// unconditional restore (#1379).

import { renderThrowable } from '@ultimat3/core';
import { driverError, SQLSTATE } from '@ultimat3/db';
import { valueAt } from './cursor';
import { MAX_CHECKED_RETRIES } from './driver-kit-checked-update';
import type { DriverScope } from './driver-scope';
import { idPlan, namedColumns } from './plan';
import type { RepoOptions, Tx } from './repo';

/** One row the batch wrote: as read before, as written, and the patch that moved it. */
export interface MovedRow<Row> {
  readonly stored: Row;
  readonly result: Row;
  readonly patch: object;
}

export interface Rollback {
  readonly op: string;
  /** The key `updateMany` addresses rows by. */
  readonly key: string;
  /** Every property the batch's patches named: what an unconditional restore writes. */
  readonly properties: readonly string[];
  readonly options: RepoOptions | undefined;
  readonly tx: Tx | undefined;
}

/** A batch whose rollback met a newer write: left as the newer writer made it, and refused. */
export const tornBatch = (table: string, kept: readonly string[], cause: unknown) =>
  driverError(`update ${table}`, {
    code: SQLSTATE.serializationFailure,
    message: `updateMany refused part way (${renderThrowable(cause)}), and ${String(kept.length)} row(s) it had written were changed by another writer before they could be written back — kept as that writer left them (${kept.join(', ')}); re-read them and re-run the batch`,
  });

/**
 * Writes each moved row back, newest first. Answers the keys left as another writer made them —
 * empty when every row was restored. A plain store answers empty: its restore is unconditional.
 */
export const restoreMoved = async <Row>(
  scope: DriverScope<Row>,
  moved: readonly MovedRow<Row>[],
  rollback: Rollback,
): Promise<readonly string[]> => {
  const { entity, raw } = scope;
  const { op, key, options, tx } = rollback;
  const kept: string[] = [];
  for (const { stored, result, patch } of [...moved].reverse()) {
    const id = String(valueAt(result, key));
    const where = scope.storePlan(op, idPlan(entity, id, options, op), true);
    const { updateChecked } = raw;
    if (updateChecked === undefined) {
      const values = Object.fromEntries(
        [...rollback.properties, key].map((property) => [property, valueAt(stored, property)]),
      );
      await raw.update({ plan: where, tx }, values);
      continue;
    }
    // Only what this row's patch named: a property it never touched is another writer's to keep.
    const named = [...namedColumns(patch).map(([property]) => property), key];
    const values = Object.fromEntries(
      named.map((property) => [property, valueAt(stored, property)]),
    );
    let restored = false;
    for (let attempt = 0; attempt <= MAX_CHECKED_RETRIES && !restored; attempt += 1) {
      const read = await raw.select({ plan: where, after: undefined, limit: 1, tx });
      const [now] = scope.checked(op, where, read);
      const ours =
        now !== undefined &&
        named.every((property) =>
          Bun.deepEquals(valueAt(now, property), valueAt(result, property)),
        );
      if (!ours) break;
      restored = await updateChecked.call(raw, { plan: where, tx }, read, values);
    }
    if (!restored) kept.push(id);
  }
  return kept;
};
