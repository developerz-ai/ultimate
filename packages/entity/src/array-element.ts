// Which element kinds `arrayOf()` refuses, and the one-line edit that repairs each. Split from
// `columns-data.ts`, which parses columns: a refusal POLICY and four repair strings are a second
// responsibility, and the file was 250 lines with both in it.

import { EntityError } from './errors';

/** The element kinds `arrayElement` (`pg-row.ts`) has no literal for, and why each one is refused. */
const ARRAY_ELEMENT_REFUSED = ['money', 'array', 'jsonb', 'bytea'] as const;

export type RefusedElement = (typeof ARRAY_ELEMENT_REFUSED)[number];

export const isRefusedElement = (kind: string): kind is RefusedElement =>
  (ARRAY_ELEMENT_REFUSED as readonly string[]).includes(kind);

/**
 * One column per refused element kind: the shape that holds the same list and can be written.
 * `Object.freeze<Record<K, V>>` and never `Readonly<Record<K, V>> = Object.freeze({…})`, which
 * infers the key set from the literal and would accept a fifth key in silence.
 *
 * Each value is a MECHANICAL edit with nothing for the reader to supply — the placeholder form
 * `json(t.array(<element schema>))` was the defect: a `fix:` a reader has to complete is one they
 * can complete wrongly, and `<element schema>` pasted verbatim is a syntax error. The two that
 * need a second table name it (`amounts`, `blobs`) rather than saying "a child table", so every
 * line is text that runs.
 */
const ARRAY_ELEMENT_FIXES = Object.freeze<Record<RefusedElement, string>>({
  money:
    'move the list to its own entity and relate it — ' +
    "entity('amounts', { columns: { amount: money() } }) — then drop this column: an array column " +
    'is ONE column and money() is three (minor, currency, scale)',
  array:
    'rewrite arrayOf(arrayOf(x)) as arrayOf(x) if the nesting carries no meaning, or move the ' +
    "inner list to its own entity and relate it — entity('items', { columns: { value: text() } })",
  jsonb:
    'rewrite arrayOf(json(S)) as json(t.array(S)) with S unchanged — one jsonb column holds the ' +
    'whole list and t.array still validates every member',
  bytea:
    'move the list to its own entity and relate it — ' +
    "entity('blobs', { columns: { data: bytes() } }) — then drop this column: one row per blob, " +
    'and bytea has no array literal that survives the driver',
});

/**
 * An element the Postgres array literal cannot carry, refused where the schema is still being
 * written. Two different reasons, one code — the situation is a single one, "this list needs a
 * different column" — so only the cause and the fix branch.
 *
 * `money` and `array` are not ONE column: three physical columns for an amount, and a nested array
 * has no unambiguous literal form. `jsonb` and `bytea` are one column each and were the silent
 * half: `arrayElement` renders any object as `""`, so two objects bound as `{"",""}` and one blob
 * as `{""}` (measured), while `memoryRepo` kept the value — a loss no test in this tree could see
 * and only a table could show.
 *
 * Not `reject()`: a declaration is repaired by an EDIT, and `reject`'s
 * `x entities describe column --json` is `X_DECLARATION_UNKNOWN` — no entity is named `column`, and
 * there is no entity at all yet. So each fix is the edit that holds the list instead.
 */
export const arrayElementRefused = (kind: RefusedElement): EntityError => {
  const singleColumn = kind === 'money' || kind === 'array';
  return new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: singleColumn
      ? `arrayOf(${kind}) has no single column behind it — an array element is one scalar column, and ${kind === 'money' ? 'money is three (minor, currency, scale)' : 'a nested array has no unambiguous literal form'}`
      : `arrayOf(${kind}) has no array literal form — every element would cross to Postgres as an empty string while memoryRepo kept the value, so the loss is invisible until the row is read back`,
    fix: ARRAY_ELEMENT_FIXES[kind],
  });
};
