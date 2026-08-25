// The refusals the two DECLARED capabilities raise at call time — full-text search and a state
// machine. Split from `errors.ts` at the 500-line ceiling; the codes and their titles stay there,
// because a registry with two homes is a registry that disagrees with itself.

import { EntityError } from './errors';

/**
 * A `matches` predicate on an entity whose columns declare no `.searchable()`.
 *
 * Raised where the STATEMENT would be built, not where the chain was written, because both drivers
 * reach it: an entity's search vector is derived from its columns, so there is nothing else the
 * predicate could name and no vector to guess at.
 */
export const searchUndeclared = (entityName: string): EntityError =>
  new EntityError({
    code: 'X_SEARCH_UNDECLARED',
    cause: `${entityName} has no searchable column, so there is no tsvector to match against`,
    fix: `add .searchable() to a text() column of ${entityName}, then: x db gen "search ${entityName}"`,
  });

/**
 * A full-text match asked of `memoryDriver()`. REFUSED rather than emulated, and that is the whole
 * decision: `to_tsvector` stems, drops stop words and applies a language's own rules, and
 * `websearch_to_tsquery` parses quoted phrases and `-`negation — a JS token comparison is a
 * DIFFERENT question with the same shape, so it would answer green in a unit test and differently
 * in production, which is the one outcome the two-driver split exists to prevent.
 */
export const searchInMemory = (entityName: string): EntityError =>
  new EntityError({
    code: 'X_SEARCH_IN_MEMORY',
    cause: `memoryDriver() cannot stem, weight or rank a tsvector, so a search of ${entityName} has no answer it could give that Postgres would agree with`,
    fix: `move this read into a <name>.live.test.ts and run it with TEST_DATABASE_URL set — bun test packages/entity/src/pg-search.live.test.ts is the model`,
  });

/**
 * `transition()` on a column that declares no `.transitions()`.
 *
 * A declaration bug and not a caller's, which is why it lists the columns that DO declare one: the
 * repair is naming a different column or writing the table, and both are edits to source.
 */
export const stateUndeclared = (
  entityName: string,
  column: string,
  machines: readonly string[],
): EntityError =>
  new EntityError({
    code: 'X_STATE_UNDECLARED',
    cause: `${entityName}.${column} declares no state machine, so there is no transition to check`,
    fix:
      machines.length === 0
        ? `add .transitions(…) to ${entityName}.${column} — it must be an enumerated() column, and every value that set declares needs an entry`
        : `${entityName} declares a machine on: ${machines.join(', ')}`,
  });

/**
 * Why a move is not in the machine. THREE conditions and one code, because they share one repair —
 * the move is not in the table — and each states its own fact, because they are not the same
 * mistake and the fix line differs.
 *
 * `unknown-state` is separate from `terminal` for a reason a test found: an unknown state has no
 * outgoing moves either, so a single "no legal moves" branch reported a typo as "the row is
 * terminal in <typo>" — a sentence about a state that does not exist. Reachable from JS, and from
 * a `from` that came out of parsed JSON.
 *
 * `terminal` is separate from the ordinary case because "no legal moves" reads like a missing
 * declaration and is not one: an empty list is how a terminal state is written.
 */
export type IllegalTransition =
  | { readonly reason: 'unknown-state'; readonly states: readonly string[] }
  | { readonly reason: 'terminal' }
  | { readonly reason: 'not-declared'; readonly legal: readonly string[] };

export const stateTransitionIllegal = (
  entityName: string,
  column: string,
  from: string,
  to: string,
  detail: IllegalTransition,
): EntityError => {
  const subject = `${entityName}.${column}`;
  if (detail.reason === 'unknown-state') {
    return new EntityError({
      code: 'X_STATE_TRANSITION_ILLEGAL',
      cause: `"${from}" is not a state of ${subject} — it declares: ${detail.states.join(' | ')}`,
      fix: `${entityName}.transition('${column}', id, { from: '${detail.states[0] ?? from}', to: '${to}' })   # name a state the enumerated() set declares`,
    });
  }
  if (detail.reason === 'terminal') {
    return new EntityError({
      code: 'X_STATE_TRANSITION_ILLEGAL',
      cause: `${subject} is terminal in "${from}": the machine declares no move out of it, so "${to}" is not one`,
      fix: `move the row before it reaches "${from}", or add "${to}" to the "${from}" entry of the transitions() table`,
    });
  }
  return new EntityError({
    code: 'X_STATE_TRANSITION_ILLEGAL',
    cause: `${subject} has no move from "${from}" to "${to}" — from "${from}" it may go to: ${detail.legal.join(', ')}`,
    fix: `${entityName}.transition('${column}', id, { from: '${from}', to: '${detail.legal[0]}' })   # or add "${to}" to the "${from}" entry of the transitions() table`,
  });
};

/**
 * The conditional update matched no row, and the row is in a different state than the caller named.
 *
 * This is the lost update, caught: two callers both read "pending", both found the move legal, and
 * the second one's statement carried `status = 'pending'` in its predicate and matched nothing. The
 * state in the cause is READ BACK after the refusal, so it is a diagnosis and never the decision —
 * the decision was the statement, and it was atomic.
 */
export const stateConflict = (
  entityName: string,
  column: string,
  id: string,
  expected: string,
  actual: string,
): EntityError =>
  new EntityError({
    code: 'X_STATE_CONFLICT',
    cause: `${entityName}.${column} named "${expected}" for row ${id}, which is in "${actual}" — something moved it first`,
    fix: `re-read the row and decide again against "${actual}": ${entityName}.findById(id) — a transition names the state it expects, so a stale read is refused rather than overwritten`,
  });
