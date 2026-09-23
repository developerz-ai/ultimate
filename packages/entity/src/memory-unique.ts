// Single responsibility: the uniqueness Postgres enforces, enforced by the in-memory driver too —
// the primary key and every non-partial `unique` index. Memory silently REPLACED a row on a
// duplicate key and ignored `unique()` entirely, so a signup race that is a 409 in production was
// a quiet overwrite under `x dev` and in every app test.

import { driverError } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { bindValues } from './pg-row';
import type { RowPatch } from './types';

/** The refusal Postgres answers `23505` with, in the shape `driverError` gives it there. */
export const uniqueViolation = (entity: EntityCore, constraint: string): Error =>
  driverError(`memory write into ${entity.$table}`, {
    code: '23505',
    constraint,
    message: `duplicate key value violates unique constraint "${constraint}"`,
  });

/** A value as a comparable token; `null` answers `undefined` — NULLS DISTINCT, as Postgres. */
const cellOf = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (typeof value === 'string') return `s:${value}`;
  return `${typeof value}:${JSON.stringify(value)}`;
};

/**
 * The first unique index `candidate` collides with among `others`, or `undefined`. Partial indexes
 * are skipped: their predicate is SQL this driver cannot evaluate, and a guess would refuse rows
 * Postgres accepts — the one direction that must never happen.
 */
export const uniqueClash = <Row>(
  entity: EntityCore<Row>,
  candidate: Row,
  others: Iterable<Row>,
): string | undefined => {
  const unique = entity.$indexes.filter((index) => index.unique && index.where === undefined);
  if (unique.length === 0) return undefined;
  const bound = (row: Row) => bindValues(entity, row as unknown as RowPatch<Row>);
  const incoming = bound(candidate);
  for (const index of unique) {
    const key = index.columns.map((name) => cellOf(incoming.get(name)));
    if (key.some((part) => part === undefined)) continue;
    for (const other of others) {
      const stored = bound(other);
      if (index.columns.every((name, at) => cellOf(stored.get(name)) === key[at]))
        return index.name;
    }
  }
  return undefined;
};
