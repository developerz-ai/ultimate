// Single responsibility: the three plain scalar columns — `text`, `integer`, `boolean` — each
// refusing in `$parse` exactly what Postgres refuses at the column, so the memory driver cannot
// store a value production answers 23514 or 22003 for. Split from `columns.ts` at its ceiling.

import { charCount } from '@ultimat3/schema';
import { column } from './column';
import { got } from './column-values';
import { refuseColumn } from './refuse';
import type { Column } from './types';

export interface TextOptions {
  /** Emits `char_length(<column>) <= max`, so Postgres refuses an over-long string too. */
  readonly max?: number;
}

export const text = (options: TextOptions = {}): Column<string> => {
  const { max } = options;
  // Refused where it is declared: a `NaN` or fractional max emitted `char_length(x) <= NaN` into
  // the DDL, which Postgres refuses one migration later, far from the line that wrote it.
  if (max !== undefined && !(Number.isSafeInteger(max) && max >= 1)) {
    refuseColumn(
      'length',
      `text({ max }) must be a whole number of characters, at least 1, ${got(max)}`,
      'text({ max: 200 }) — a whole count of characters, or text() for no bound',
    );
  }
  return column<string>(
    'text',
    (value) => {
      if (typeof value !== 'string') {
        return refuseColumn(
          'type',
          `expected a string, ${got(value)}`,
          'String(value) at the call site when this really is text — a number column is integer(), an exact decimal is decimal(), a structured payload is json(schema)',
        );
      }
      // Code points, as `char_length` counts them: the CHECK refused an over-long value in
      // Postgres (23514) while memory stored it, so a test passed a write production refuses.
      if (max !== undefined && charCount(value) > max) {
        return refuseColumn(
          'length',
          `expected at most ${max} characters, got ${charCount(value)}`,
          `truncate at the call site, or widen the column — text({ max: ${charCount(value)} }) — and run x db gen "widen the text"`,
        );
      }
      return value;
    },
    max === undefined ? {} : { length: max, check: (name) => `char_length(${name}) <= ${max}` },
  );
};

/** Postgres `integer` is int4: a safe JS integer past this range is 22003 there. */
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

export const integer = (): Column<number> =>
  column<number>('integer', (value) =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= INT4_MIN &&
    value <= INT4_MAX
      ? value
      : refuseColumn(
          'type',
          `expected a whole number in the int4 range (${INT4_MIN}..${INT4_MAX}), ${got(value)}`,
          'Math.trunc(value) for a float and Number(value) for a numeric string — a count past int4 is bigint(), a fractional value is decimal()',
        ),
  );

export const boolean = (): Column<boolean> =>
  column<boolean>('boolean', (value) =>
    typeof value === 'boolean'
      ? value
      : refuseColumn(
          'type',
          `expected a boolean, ${got(value)}`,
          "value === 'true' at the call site for a text flag, and boolean().nullable() when the column has a third state",
        ),
  );
