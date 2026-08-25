// Single responsibility: what a column's DEFAULT is, as SQL. Split out of `generate.ts` because
// the question has two halves that must be answered together — what a declared default renders as,
// and what it MEANS when a column claims one this generator cannot write down. That second half
// had no answer at all until 2026-08-25: `hasDefault` reached the generator with no expression
// beside it, so nine scalar defaults in the reference app's own schema were dropped in silence and
// only `now()` and `gen_random_uuid()` survived, because those two are inferable from the kind.

import { assert } from '@ultimat3/core';
import { literal } from './sql';

/**
 * Structurally assignment-compatible with `@ultimat3/entity`'s `ColumnDefault`. Declared here
 * rather than in `entity-shape.ts` so `defaultExpression` can name it without an import cycle,
 * exactly as `IndexMethod` lives in `index-method.ts` and is read from the mirror.
 *
 * `uuid-v7` is what `entity()` stamps on a generated uuid key. It renders `gen_random_uuid()` —
 * a v4 — because that is the only server-side generator Postgres 17 ships and it is what this
 * generator has always emitted for such a key. The v7 is minted in JS on the write path; the
 * column default is the fallback for a row nothing in this framework inserted.
 */
export type ColumnDefaultLike =
  | { readonly kind: 'value'; readonly value: string | number | boolean | null }
  | { readonly kind: 'generated'; readonly by: 'uuid-v7' | 'now' };

/** The parts of a column description this file reads — nothing else. */
interface DefaultedColumn {
  readonly column: string;
  readonly property: string;
  readonly kind: string;
  readonly primaryKey: boolean;
  readonly hasDefault: boolean;
  readonly default?: ColumnDefaultLike | undefined;
}

/**
 * A literal reaches the statement TEXT — `create table` takes no parameters — so a string is
 * quoted through the one escape this package has (`literal`), and a number this build cannot
 * write down is refused rather than emitted as `NaN`, which is a syntax error whose first reader
 * would be `ROLE=migrate`.
 */
function literalSql(column: DefaultedColumn, value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return literal(value).text;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  assert(
    Number.isFinite(value),
    `column "${column.column}" declares a default of ${String(value)}, which is not a number Postgres can hold`,
    `.default(0)   # give "${column.property}" a finite number, or drop the default`,
  );
  return String(value);
}

/**
 * The `default …` a column clause carries, or `null` for a column that has none this generator can
 * write. A DECLARED default wins over an inferred one; the two inferences below stay as the
 * fallback for a description whose producer does not yet project the expression — see
 * `unrenderedDefault`, which is what stops that fallback from being a silent loss.
 */
export function defaultExpression(column: DefaultedColumn): string | null {
  if (!column.hasDefault) return null;
  const declared = column.default;
  if (declared !== undefined) {
    return declared.kind === 'value'
      ? literalSql(column, declared.value)
      : declared.by === 'now'
        ? 'now()'
        : 'gen_random_uuid()';
  }
  if (column.kind === 'uuid' && column.primaryKey) return 'gen_random_uuid()';
  if (column.kind === 'timestamptz') return 'now()';
  return null;
}

/**
 * Whether this column claims a default the generated SQL does not carry. Exactly the condition
 * that lost nine columns' defaults in silence: `hasDefault: true` with nothing to render it from.
 */
export function hasUnrenderedDefault(column: DefaultedColumn): boolean {
  return column.hasDefault && defaultExpression(column) === null;
}
