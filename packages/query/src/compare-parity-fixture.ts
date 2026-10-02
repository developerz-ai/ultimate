// The ONE `(kind, left, right)` table "how does Postgres compare a column" is checked against, by
// three readers: `@ultimat3/entity`'s evaluator, this package's matcher and source, and — in the
// `live` suite — a real server. `order` and `equal` are the DATABASE's answers; a row either
// JS reader gets wrong fails `compare-parity.test.ts` with no server needed.

import type { ColumnKind } from '@ultimat3/entity';
import {
  bigint,
  boolean,
  date,
  decimal,
  entity,
  integer,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import type { Patch } from './matcher';

/** The relation every parity read names — `QueryShape.entity`, which is where kinds resolve. */
export const PARITY_TABLE = 'query_compare_parity';

/**
 * One column per kind, NAMED for its kind. Declared by the caller, inside its own `beforeAll`: an
 * entity registered at import would outlive the file and reach every suite sharing the process.
 */
export const declareParityEntity = () =>
  entity(PARITY_TABLE, {
    columns: {
      id: text({ max: 40 }).primaryKey(),
      uuid: uuid().nullable(),
      text: text({ max: 40 }).nullable(),
      boolean: boolean().nullable(),
      integer: integer().nullable(),
      bigint: bigint().nullable(),
      numeric: decimal({ precision: 20, scale: 4 }).nullable(),
      timestamptz: timestamp().nullable(),
      date: date().nullable(),
    },
  });

/** The kinds the table covers, each with the Postgres type the live suite casts a value to. */
export const PARITY_PG_TYPE = Object.freeze<Partial<Record<ColumnKind, string>>>({
  uuid: 'uuid',
  // "C", so the answer is the ordering rule and not one deployment's `lc_collate`.
  text: 'text collate "C"',
  boolean: 'boolean',
  integer: 'integer',
  bigint: 'bigint',
  numeric: 'numeric',
  timestamptz: 'timestamptz',
  date: 'date',
});

export interface ParityRow {
  readonly kind: ColumnKind;
  /** The value a repository row holds for that kind. */
  readonly left: unknown;
  /** A second row's value — or a filter operand, which is what a caller writes. */
  readonly right: unknown;
  /** `left` against `right` under `order by … asc`: what Postgres answers. */
  readonly order: -1 | 0 | 1;
  /** `left = right`: what Postgres answers. */
  readonly equal: boolean;
}

const row = (
  kind: ColumnKind,
  left: unknown,
  right: unknown,
  order: -1 | 0 | 1,
  equal = order === 0,
): ParityRow => ({ kind, left, right, order, equal });

const at = (iso: string): Date => new Date(iso);
const UUID_LOW = '00000000-0000-7000-8000-00000000000a';
const UUID_HIGH = '00000000-0000-7000-8000-00000000000b';

/**
 * The first four are the rows the two comparators disagreed on before there was one: a `bigint()`
 * and a `decimal()` row are decimal TEXT, a `uuid` is a value whatever its case, and an instant
 * handed over as ISO text is the instant it names.
 */
export const PARITY: readonly ParityRow[] = [
  row('bigint', '10', '9', 1),
  row('numeric', '2.50', '10', -1),
  row('uuid', UUID_LOW.toUpperCase(), UUID_LOW, 0),
  row('timestamptz', at('2026-02-01T00:00:00.000Z'), '2026-02-01T00:00:00.000Z', 0),

  row('bigint', '9', '10', -1),
  row('bigint', '-10', '9', -1),
  row('bigint', '100', '100', 0),
  // Past 2^53, where a `number` cannot tell the two apart.
  row('bigint', '9007199254740993', '9007199254740992', 1),
  // A filter operand is usually a literal: `where({ total: 10 })` against a row holding `'10'`.
  row('bigint', '10', 10, 0),
  row('bigint', '10', 9, 1),
  row('bigint', '10', 10n, 0),

  row('numeric', '2.50', '2.5', 0),
  row('numeric', '0.1', '0.10', 0),
  row('numeric', '2.50', 2.5, 0),
  row('numeric', '-1.5', '-1.25', -1),
  row('numeric', '10.00', '9.99', 1),
  row('numeric', '-0.00', '0', 0),

  row('integer', 10, 9, 1),
  row('integer', -1, 1, -1),
  row('integer', 9, 9, 0),

  row('uuid', UUID_HIGH.toUpperCase(), UUID_LOW, 1),
  row('uuid', UUID_LOW, UUID_HIGH.toUpperCase(), -1),
  row('uuid', UUID_LOW, UUID_LOW, 0),

  row('timestamptz', at('2026-02-01T00:00:00.000Z'), at('2026-02-01T00:00:00.001Z'), -1),
  row('timestamptz', at('2026-02-01T00:00:00.000Z'), '2026-02-01T01:00:00.000+01:00', 0),
  row('timestamptz', at('2026-02-01T00:00:00.000Z'), '2026-01-31T23:00:00.000Z', 1),

  // Digits in a TEXT column are characters: `'10' < '9'`, which is exactly why the kind decides.
  row('text', '10', '9', -1),
  row('text', 'abc', 'abd', -1),
  row('text', 'a', 'a', 0),

  row('boolean', false, true, -1),
  row('boolean', true, true, 0),

  row('date', '2026-01-09', '2026-01-10', -1),
  row('date', '2026-01-10', '2026-01-10', 0),
];

/** A window after its patches — what a subscriber's list looks like once the matcher has spoken. */
export function applied<TRow extends { readonly id: string }>(
  rows: readonly TRow[],
  patches: readonly Patch<TRow>[],
): readonly TRow[] {
  const next = [...rows];
  for (const patch of patches) {
    if (patch.kind === 'add') next.splice(patch.position, 0, patch.row);
    if (patch.kind === 'update') next[patch.position] = patch.row;
    if (patch.kind === 'remove') next.splice(patch.position, 1);
  }
  return next;
}
