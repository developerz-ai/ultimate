// Single responsibility: the uniqueness Postgres enforces, enforced by the in-memory driver too —
// the primary key and every non-partial unique, an index or an invariant (`unique-constraints.ts`). Memory silently REPLACED a row on a
// duplicate key and ignored `unique()` entirely, so a signup race that is a 409 in production was
// a quiet overwrite under `x dev` and in every app test.

import { keyOf } from './batch-read';
import { columnName } from './column';
import { entityUniqueViolation } from './driver-errors';
import type { EntityCore } from './entity';
import { bindValues } from './pg-row';
import type { RowPatch } from './types';
import { uniqueConstraints } from './unique-constraints';

/**
 * The refusal Postgres answers `23505` with: `X_DB_UNIQUE_VIOLATION` carrying `23505`, through
 * `driver-errors.ts` — the one builder every non-Postgres store raises it with
 * (`unique-violation-parity.test.ts` holds it equal to the Postgres driver's).
 */
export const uniqueViolation = (entity: EntityCore, constraint: string): Error =>
  entityUniqueViolation(entity, constraint);

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

/** Each unique constraint's key for a row, in declaration order; `undefined` where a part is NULL. */
const keysOf = <Row>(entity: EntityCore<Row>) => {
  const unique = uniqueConstraints(entity);
  const kinds = kindsOf(entity);
  return {
    unique,
    keys: (row: Row): readonly (string | undefined)[] => {
      const bound = bindValues(entity, row as unknown as RowPatch<Row>);
      return unique.map((index) => {
        const parts = index.columns.map((name) => cellOf(kinds.get(name), bound.get(name)));
        return parts.some((part) => part === undefined) ? undefined : JSON.stringify(parts);
      });
    },
  };
};

/** One constraint's keys, counted: a seed or a trigger's raw write may hold one key twice. */
type Taken = Map<string, number>;

const holds = (taken: readonly Taken[], i: number, key: string | undefined): number =>
  key === undefined ? 0 : (taken[i]?.get(key) ?? 0);

const move = (taken: readonly Taken[], keys: readonly (string | undefined)[], by: 1 | -1): void =>
  keys.forEach((key, i) => {
    const at = taken[i];
    if (key === undefined || at === undefined) return;
    const left = (at.get(key) ?? 0) + by;
    if (left > 0) at.set(key, left);
    else at.delete(key);
  });

/**
 * Every unique key a set of rows holds, one count per constraint: a batch is judged against it row
 * by row, each row bound once. A scan of every other row per row — rebound per constraint — made a
 * 1,000-row `insertAll` take tens of seconds.
 *
 * `under` is a second index this one is layered over: a key either holds is taken. `insertAll`
 * judges its batch over the stored rows' index this way, so a batch never copies the table.
 */
export interface UniqueIndex<Row> {
  /** The first constraint, in declaration order, `row` collides on — or `undefined`. */
  clash(row: Row): string | undefined;
  add(row: Row): void;
}

export function uniqueIndex<Row>(
  entity: EntityCore<Row>,
  rows: Iterable<Row>,
  under?: StoredRows<Row>,
): UniqueIndex<Row> {
  const { unique, keys } = keysOf(entity);
  const taken: Taken[] = unique.map(() => new Map());
  const index: UniqueIndex<Row> = {
    clash(row) {
      if (unique.length === 0) return undefined;
      const mine = keys(row);
      const at = mine.findIndex(
        (key, i) => holds(taken, i, key) > 0 || (under?.holds(i, key) ?? false),
      );
      return at === -1 ? undefined : unique[at]?.name();
    },
    add(row) {
      if (unique.length > 0) move(taken, keys(row), 1);
    },
  };
  for (const row of rows) index.add(row);
  return index;
}

/**
 * The memory driver's table: a `Map` from store key to row that keeps every non-partial unique's
 * keys as rows come and go. Every way a row moves — a write, a delete, a trigger's raw write, an
 * undo run by a rollback, a reset — is a `set`, `delete` or `clear` on this map, so the index
 * cannot miss one. Rebuilt per write, it made N single inserts cost N² (1,100 rows: ~14 s).
 *
 * A row's keys are recorded as it lands and removed by that record, so removal never rebinds.
 */
export class StoredRows<Row> extends Map<string, Row> {
  readonly #unique;
  readonly #keys;
  readonly #taken: Taken[];
  readonly #held = new Map<string, readonly (string | undefined)[]>();

  constructor(entity: EntityCore<Row>) {
    super();
    const { unique, keys } = keysOf(entity);
    this.#unique = unique;
    this.#keys = keys;
    this.#taken = unique.map(() => new Map());
  }

  override set(key: string, row: Row): this {
    if (this.#unique.length > 0) {
      this.#release(key);
      const keys = this.#keys(row);
      move(this.#taken, keys, 1);
      this.#held.set(key, keys);
    }
    return super.set(key, row);
  }

  override delete(key: string): boolean {
    this.#release(key);
    return super.delete(key);
  }

  override clear(): void {
    for (const taken of this.#taken) taken.clear();
    this.#held.clear();
    super.clear();
  }

  /** Whether constraint `i` holds `key` — for an index layered over this one. */
  holds(i: number, key: string | undefined): boolean {
    return holds(this.#taken, i, key) > 0;
  }

  /**
   * The first constraint, in declaration order, `row` collides on among the stored rows — the row
   * stored under `from` excepted: it is the one `row` replaces. Partial uniques are not in the list:
   * their predicate is SQL this driver cannot evaluate, and a guess would refuse rows Postgres
   * accepts — the one direction that must never happen.
   */
  clash(row: Row, from?: string): string | undefined {
    if (this.#unique.length === 0) return undefined;
    const own = from === undefined ? undefined : this.#held.get(from);
    const at = this.#keys(row).findIndex(
      (key, i) => holds(this.#taken, i, key) - (key !== undefined && own?.[i] === key ? 1 : 0) > 0,
    );
    return at === -1 ? undefined : this.#unique[at]?.name();
  }

  #release(key: string): void {
    const keys = this.#held.get(key);
    if (keys === undefined) return;
    move(this.#taken, keys, -1);
    this.#held.delete(key);
  }
}
