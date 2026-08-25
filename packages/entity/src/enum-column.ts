// The one column that may declare a state machine, and the only one that could: `enumerated()`
// already declares the closed set of values a machine moves through, as a CHECK the migration
// emits. Split from `columns.ts` at the 500-line ceiling, along the seam the extra chain draws.

import { BARE, makeColumn } from './column';
import { got, oneOf } from './column-values';
import { refuseColumn } from './refuse';
import { stateMachineOf } from './state-machine';
import type { ColumnMeta, EnumeratedColumn } from './types';

/**
 * A closed set of strings, emitted as a CHECK rather than a Postgres `ENUM` type: adding a
 * variant is then a one-line migration instead of `ALTER TYPE`, which cannot run inside a
 * transaction on older servers.
 */
export const enumerated = <const V extends readonly string[]>(values: V): EnumeratedColumn<V> => {
  const allowed = new Set<string>(values);
  const parse = (value: unknown): V[number] =>
    typeof value === 'string' && allowed.has(value)
      ? value
      : refuseColumn(
          'enum',
          `expected one of ${values.join(' | ')}, ${got(value)}`,
          'store one of the values enumerated() declares, or add the new variant to that list and run x db gen "extend the enum check" — the values are a CHECK constraint, so the table moves with them',
        );
  return enumeratedWith<V, false>(
    { ...BARE, kind: 'text', values, check: oneOf(values) },
    values,
    parse,
    false,
  );
};

/**
 * Every link delegates to the general chain and re-wraps its `$meta`, so there is one definition of
 * what `.default()` accepts and of how `.column()` validates a name — this file adds only the two
 * rules the general chain cannot know: a machine may be declared here, and a column carrying one
 * may not hold NULL.
 */
const enumeratedWith = <V extends readonly string[], Optional extends boolean>(
  meta: ColumnMeta,
  values: V,
  parse: (value: unknown) => V[number],
  optional: Optional,
): EnumeratedColumn<V, Optional> => {
  const base = makeColumn<V[number], Optional>(meta, parse, optional);
  return {
    ...base,
    transitions: (table) => {
      // Refused in BOTH directions, so neither order of the chain can produce the column that has
      // no answer: NULL is not one of the declared states, so nothing could say what it may move
      // to — and the compare-and-set the write path uses compares it with `=`, where NULL matches
      // no row at all and every transition out of it would read as a conflict.
      if (!meta.notNull) {
        refuseColumn(
          'transitions',
          'a state machine column may not hold null — null is not one of the declared states',
          'drop .nullable() from this column, or drop .transitions() — a row outside every state has no legal move',
        );
      }
      return enumeratedWith<V, Optional>(
        { ...meta, machine: stateMachineOf(values, table) },
        values,
        parse,
        optional,
      );
    },
    default: (value) => enumeratedWith<V, true>(base.default(value).$meta, values, parse, true),
    column: (name) => enumeratedWith<V, Optional>(base.column(name).$meta, values, parse, optional),
    nullable: () => {
      if (meta.machine !== undefined) {
        refuseColumn(
          'transitions',
          'a state machine column may not hold null — null is not one of the declared states',
          'drop .nullable() from this column, or drop .transitions() — a row outside every state has no legal move',
        );
      }
      return base.nullable();
    },
  };
};
