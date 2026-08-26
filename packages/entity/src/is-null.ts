// Single responsibility: what this package means by NULL when it looks at a row. One rule, because
// three files had their own copy of it — `memory-match.ts`, `containment.ts` and, the moment
// `isNull()` joined the invariant vocabulary, `expr.ts`.

/**
 * Absent and NULL are one value. `undefined` is a key nobody typed or a column a projection left
 * out; `null` is one the row spelled. Postgres cannot tell them apart and neither may anything
 * reading a row here.
 *
 * A copy is not free: the rule decides whether a row the caller never NAMED a column on is the same
 * row as one that stored `null`, and the table holds NULL for both. `===` made them two, and
 * `eq null` then skipped the absent row while `neq null` answered it — the opposite of the same
 * predicate in production.
 */
export const isNullish = (value: unknown): boolean => value === null || value === undefined;
