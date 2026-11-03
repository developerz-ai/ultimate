// Single responsibility: the uniqueness Postgres enforces, enforced by the in-memory driver too —
// the primary key and every non-partial unique, an index or an invariant (`unique-constraints.ts`). Memory silently REPLACED a row on a
// duplicate key and ignored `unique()` entirely, so a signup race that is a 409 in production was
// a quiet overwrite under `x dev` and in every app test.

import { driverError } from '@ultimat3/db';
import { keyOf } from './batch-read';
import { columnName } from './column';
import type { EntityCore } from './entity';
import { bindValues } from './pg-row';
import type { RowPatch } from './types';
import { uniqueConstraints } from './unique-constraints';

/** The refusal Postgres answers `23505` with, in the shape `driverError` gives it there. */
export const uniqueViolation = (entity: EntityCore, constraint: string): Error =>
  driverError(`memory write into ${entity.$table}`, {
    code: '23505',
    constraint,
    message: `duplicate key value violates unique constraint "${constraint}"`,
  });

/** A number's kinds: `'2.5'` and `'2.50'` are one key to Postgres, and so are `7` and `'7'`. */
const BY_VALUE: ReadonlySet<string> = new Set(['integer', 'bigint', 'numeric']);

/** A value as a comparable token; `null` answers `undefined` — NULLS DISTINCT, as Postgres. */
const cellOf = (kind: string | undefined, value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (kind !== undefined && BY_VALUE.has(kind)) return `n:${keyOf(kind, value)}`;
  if (typeof value === 'string') return `s:${kind === undefined ? value : keyOf(kind, value)}`;
  return `${typeof value}:${JSON.stringify(value)}`;
};

/** Physical column -> kind. A money part is absent: its cells compare as the values they hold. */
const kindsOf = <Row>(entity: EntityCore<Row>): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(entity.$columns)
      .filter(([, column]) => column.$meta.kind !== 'money')
      .map(([property, column]) => [columnName(property, column.$meta), column.$meta.kind]),
  );

/**
 * The first unique constraint `candidate` collides with among `others`, or `undefined`. Partial
 * ones are skipped: their predicate is SQL this driver cannot evaluate, and a guess would refuse
 * rows Postgres accepts — the one direction that must never happen.
 */
export const uniqueClash = <Row>(
  entity: EntityCore<Row>,
  candidate: Row,
  others: Iterable<Row>,
): string | undefined => {
  const unique = uniqueConstraints(entity);
  if (unique.length === 0) return undefined;
  const bound = (row: Row) => bindValues(entity, row as unknown as RowPatch<Row>);
  const incoming = bound(candidate);
  const kinds = kindsOf(entity);
  for (const index of unique) {
    const key = index.columns.map((name) => cellOf(kinds.get(name), incoming.get(name)));
    if (key.some((part) => part === undefined)) continue;
    for (const other of others) {
      const stored = bound(other);
      if (index.columns.every((name, at) => cellOf(kinds.get(name), stored.get(name)) === key[at]))
        return index.name();
    }
  }
  return undefined;
};
