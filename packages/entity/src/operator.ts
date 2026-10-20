// The predicate vocabulary as ONE runtime list, the `Operator` type derived from it, and the one
// refusal for anything outside it. Both drivers and the chain's `andWhere` raise the same error, so
// an operator the type would have rejected cannot become "no rows" in one driver and a misleading
// SQL refusal in the other just because nothing typechecked the call.

import { EntityError } from './entity-error';
import type { Predicate } from './tenancy';

/**
 * The predicate vocabulary, closed. The four after `is-not-null` are the CONTAINMENT half, added
 * 2026-08-24: a `json()` or `arrayOf()` column was declared, written and then unfilterable — the ten
 * operators before them could compare a column to a scalar and nothing else — so an app storing
 * either had to leave the query language for hand-written SQL, which is the one read path in this
 * framework with no tenancy guard on it. Their meaning is Postgres', written once in
 * `containment.ts` and read by both drivers.
 *
 * There is deliberately no jsonpath EXPRESSION operator beside them: `contains` already matches
 * nested structure (`data @> '{"a":{"b":1}}'`), and a path language inside the query language
 * would be a second way to ask one question.
 *
 * `matches` is the FULL-TEXT half, added 2026-08-24. Its `column` is not a column: it is
 * `SEARCH_PROPERTY`, and both drivers branch on the OPERATOR and read the entity's own `$search` —
 * a `tsvector` is a physical column no row carries. The operand is a search TERM, always bound.
 */
export const OPERATORS = [
  'eq',
  'neq',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'is-null',
  'is-not-null',
  'contains',
  'contained-by',
  'overlaps',
  'has-key',
  'matches',
] as const;

export type Operator = (typeof OPERATORS)[number];

const KNOWN: ReadonlySet<unknown> = new Set<unknown>(OPERATORS);

export const isOperator = (op: unknown): op is Operator => KNOWN.has(op);

/** The SQL spellings an author reaches for first, each to the operator it means here. */
const SQL_SYMBOLS: ReadonlyMap<string, Operator> = new Map<string, Operator>([
  ['>', 'gt'],
  ['>=', 'gte'],
  ['<', 'lt'],
  ['<=', 'lte'],
  ['=', 'eq'],
  ['==', 'eq'],
  ['===', 'eq'],
  ['!=', 'neq'],
  ['!==', 'neq'],
  ['<>', 'neq'],
]);

/**
 * The operator a near miss meant: a SQL symbol, or a known word in another case or with `_` or a
 * space for `-` (`'GT'`, `'is_null'`, `'is not null'`). `undefined` when nothing is close enough
 * to name — a guess there would be a fix that changes the question.
 */
export const operatorMeant = (op: unknown): Operator | undefined => {
  if (typeof op !== 'string') return undefined;
  const trimmed = op.trim();
  const symbol = SQL_SYMBOLS.get(trimmed);
  if (symbol !== undefined) return symbol;
  const word = trimmed.toLowerCase().replaceAll(/[\s_]+/g, '-');
  return isOperator(word) ? word : undefined;
};

/** A value from an app, rendered so building the message can never throw instead of refusing. */
const shown = (op: unknown): string =>
  typeof op === 'string' ? `'${op}'` : typeof op === 'symbol' ? String(op) : `a ${typeof op}`;

/** A column name as the single-quoted literal the call is written with. */
const quoted = (text: string): string =>
  `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/**
 * An operator outside `OPERATORS`. The fix OPENS with the call to paste — the operator meant
 * substituted when there is one, a placeholder when nothing is close — and carries the whole list
 * after it; the sentence about what went wrong is the cause's. The call is written as `andWhere(…)`,
 * never `<entity>.andWhere(…)`: the entity name is not the variable the author's chain hangs off
 * (`describeCommand`'s rule).
 */
export const operatorUnknown = (entityName: string, column: string, op: unknown): EntityError => {
  const meant = operatorMeant(op);
  const list = OPERATORS.join(', ');
  return new EntityError({
    code: 'X_ENTITY_OPERATOR_UNKNOWN',
    cause:
      meant === undefined
        ? `${entityName}: the predicate on ${quoted(column)} names ${shown(op)}, which is not an operator — read as "no row matches" it would answer an empty list with no error`
        : `${entityName}: the predicate on ${quoted(column)} names ${shown(op)}, which is not an operator — the operator for it is '${meant}'. Read as "no row matches" it would answer an empty list with no error`,
    fix:
      meant === undefined
        ? `andWhere(${quoted(column)}, '<operator>', value)   # one of: ${list}`
        : `andWhere(${quoted(column)}, '${meant}', value)   # operators: ${list}`,
  });
};

/**
 * The predicate `andWhere` appends, refused on the line the author wrote and before any driver sees
 * the plan: an operator that is not one (`'>'` for `'gt'`) reaches it whenever the call is not
 * typechecked. The drivers refuse it too, identically, for a plan built by hand.
 */
export const checkedPredicate = (
  entityName: string,
  column: string,
  op: unknown,
  value: unknown,
): Predicate => {
  if (!isOperator(op)) throw operatorUnknown(entityName, column, op);
  return { column, op, value };
};
