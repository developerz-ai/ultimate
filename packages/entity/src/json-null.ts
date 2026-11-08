// Single responsibility: when a `null` handed to a column is the JSON VALUE `null` rather than SQL
// NULL. One rule, read by the parsers, the Postgres binder and decoder, and the memory matcher —
// a copy in any one of them is a row the two drivers spell differently.

import type { ColumnMeta } from './types';

/**
 * A NOT NULL `jsonb` column: the table holds no SQL NULL, so a `null` reaching it can only be the
 * JSON literal, judged by the column's schema like any other JSON value and stored as
 * `'null'::jsonb`. A NULLABLE `jsonb` column keeps `null` as SQL NULL — the clear every other
 * nullable column means by it, and what `is null` answers in both drivers.
 */
export const holdsJsonNull = (meta: ColumnMeta): boolean => meta.kind === 'jsonb' && meta.notNull;
