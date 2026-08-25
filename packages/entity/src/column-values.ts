// Two things every column builder needs and neither owns: how a rejected value is DESCRIBED, and
// the CHECK a closed set of values emits. Here rather than in `columns.ts` so `enum-column.ts` can
// read them without importing the file that imports it.

import { describeValue } from '@ultimat3/schema';

/**
 * The rejected value, rendered as its SHAPE and never its content — `@ultimat3/schema`'s
 * `describeValue`, the same renderer every builtin validator fails through, so a column and a
 * schema describe one bad value the same way.
 *
 * WHY it is not `String(value)`: a column rejection is not a private diagnostic. It becomes
 * `X_INVARIANT_VIOLATED`'s `cause` and a `$view` issue, which `@ultimat3/http` returns to the
 * caller AND writes into the log line — and core's logger redacts by KEY, so a value baked into a
 * message has no key left to redact. `text()` on a password field wrote the mistyped password to
 * the central log index in cleartext and into the user's own network tab; a `uuid()` holding an
 * API key surrogate does the same. A column is the worse half of that pair, because the value can
 * arrive from the DATABASE — so the leak is not bounded by what someone just typed.
 *
 * `got` stays `got` and the "expected …" half is untouched: only what follows it changes.
 */
export const got = (value: unknown): string => `got ${describeValue(value)}`;

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const oneOf =
  (values: readonly string[]) =>
  (name: string): string =>
    `${name} in (${values.map(quote).join(', ')})`;
