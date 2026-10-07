// One atomic move of one row through its column's state machine: the legality question answered
// from the declaration, the move made by a single conditional statement, and the diagnosis of a
// statement that matched nothing. Split from `query.ts` for the line ceiling and because this is
// the one write whose refusal is a READ — see `diagnose`.

import { columnFor } from './column';
import type { EntityCore } from './entity';
import { notFound } from './errors';
import type { IllegalTransition } from './feature-errors';
import {
  stateConflict,
  stateRowChanged,
  stateTransitionIllegal,
  stateUndeclared,
} from './feature-errors';
import { singleKeyOf } from './plan';
import type { Repo, RepoOptions } from './repo';
import { canMove, isState, isTerminal, movesFrom, type StateMachine } from './state-machine';
import { changedPins, pinsOf, type TransitionObservation } from './transition-pins';
import type { ColumnMap, IdOf, RowPatch } from './types';

/**
 * What a caller names: the state it believes the row is in, the one it wants, and — when the move
 * was DECIDED about the row — what that decision read, so the statement refuses a row that has
 * changed under it (`transition-pins.ts`).
 */
export interface Move<S extends string = string> {
  readonly from: S;
  readonly to: S;
  readonly observed?: TransitionObservation;
}

/** Every property whose column declares a machine — what `X_STATE_UNDECLARED` lists back. */
export const machineColumns = <Row, C extends ColumnMap>(
  entity: EntityCore<Row, C>,
): readonly string[] =>
  Object.entries(entity.$columns)
    .filter(([, column]) => column.$meta.machine !== undefined)
    .map(([property]) => property);

/**
 * The machine on a named column, or the refusal. `columnFor` and not `$columns[property]`: the name
 * is caller data on this path, and a plain read answers an `Object.prototype` member.
 */
export const machineFor = <Row, C extends ColumnMap>(
  entity: EntityCore<Row, C>,
  property: string,
): StateMachine => {
  const machine = columnFor(entity.$columns, property)?.$meta.machine;
  if (machine === undefined) {
    throw stateUndeclared(entity.$name, property, machineColumns(entity));
  }
  return machine;
};

/**
 * Why the statement matched no row, asked only once it already has.
 *
 * A read AFTER the decision, never before one: the conditional update is what refused, and this
 * exists so the refusal carries the state the row is really in instead of "0 rows". It is
 * tenant-scoped like every other read, so a row belonging to another org reads as absent and the
 * caller is told `X_NOT_FOUND` — which is the truth available to them, and the only answer that
 * does not confirm the row exists somewhere.
 */
const diagnose = async <Row>(
  entity: EntityCore<Row>,
  repo: Repo<Row>,
  property: string,
  id: IdOf<Row>,
  move: Move,
  pinned: { readonly key: string; readonly pins: Readonly<Record<string, unknown>> },
  options: RepoOptions | undefined,
): Promise<Error> => {
  const row = await repo.findById(id, options);
  if (row === null) return notFound(entity.$name, String(id));
  const actual = (row as Readonly<Record<string, unknown>>)[property];
  if (String(actual) !== move.from) {
    return stateConflict(entity.$name, property, String(id), move.from, String(actual));
  }
  // The state is still the one named, so a PIN refused it. A pin that reads equal again (changed
  // and changed back after the statement) is still named: the statement is what decided.
  const changed = changedPins(entity, row, pinned.pins);
  const named = changed.length > 0 ? changed : Object.keys(pinned.pins);
  return stateRowChanged(entity.$name, property, String(id), pinned.key, named);
};

const whyNot = (machine: StateMachine, move: Move): IllegalTransition => {
  if (!isState(machine, move.from)) return { reason: 'unknown-state', states: machine.states };
  if (isTerminal(machine, move.from)) return { reason: 'terminal' };
  return { reason: 'not-declared', legal: movesFrom(machine, move.from) };
};

/**
 * The move, made by ONE statement.
 *
 * The predicate carries the state the caller expects, so the state that was OBSERVED and the state
 * that was WRITTEN are one decision the database made under its own row lock. A read-then-check-
 * then-write is the same code with a window in it: two callers both read `pending`, both find the
 * move legal, and both write — and the second write is a transition out of a state the row had
 * already left. Here the second statement's `status = 'pending'` matches nothing, and no rows is
 * the refusal.
 *
 * The legality question is answered before the statement rather than inside it, because the
 * transition table is not in the database and does not belong there: it is a property of the
 * declaration, so an illegal move is refused without a round trip and without touching the row.
 *
 * The row is READ BACK afterwards rather than returned by the statement. `updateWhere` answers a
 * count in both drivers, and a second read is honest about what it is — the row as it stands now,
 * which is the row this call moved unless something moved it again, and something moving it again
 * is exactly what this design permits and reports.
 */
export const transitionRow = async <Row, C extends ColumnMap>(
  entity: EntityCore<Row, C>,
  repo: Repo<Row>,
  property: string,
  id: IdOf<Row>,
  move: Move,
  patch: (values: RowPatch<Row>) => RowPatch<Row>,
  options: RepoOptions | undefined,
): Promise<Row> => {
  const machine = machineFor(entity, property);
  if (!canMove(machine, move.from, move.to)) {
    // Asked in this order and no other: an unknown state is terminal-looking (no outgoing moves)
    // and a terminal state is legal-list-looking (an empty list), so a check that skipped either
    // one would answer a true sentence about the wrong thing.
    throw stateTransitionIllegal(entity.$name, property, move.from, move.to, whyNot(machine, move));
  }
  // `as unknown as`, and the double step is the honest one: `RowPatch<Row>` is a mapped type over
  // an UNRESOLVED `Row`, so it never reduces and no object literal is ever assignable to it — the
  // same reason `expr.ts` and `@ultimat3/query`'s `paginate` spell theirs the same way. The column
  // name came from `machineFor`, which resolved it against the entity, so the shape is a real one.
  // Keyed on the entity's OWN primary key, never the literal `id`: a `code`-keyed entity has no
  // `id` column, so the filter matched nothing in memory (a false `X_STATE_CONFLICT`) and named a
  // column Postgres does not have (`X_INVARIANT_VIOLATED`).
  // An absent id names no row, and is refused HERE: `namedColumns` drops an `undefined` filter
  // value, so the predicate below would be the from-state alone and move every row in it.
  if (id === undefined || id === null) throw notFound(entity.$name, String(id));
  const key = singleKeyOf(entity, 'transition');
  // The pins FIRST and the key and state after, so nothing observed can widen the address. The
  // columns the decision read ride in the same statement as `from`, so a reassignment committed
  // before it matches nothing, and one in flight is waited on and then re-checked by Postgres on
  // the row it left behind — the window between a policy's read and the move, closed (#702).
  const pins = pinsOf(entity, key, property, id, move.observed);
  const filter = { ...pins, [key]: id, [property]: move.from } as unknown as RowPatch<Row>;
  const values = { [property]: move.to } as unknown as RowPatch<Row>;
  const written = await repo.updateWhere(filter, patch(values), options);
  if (written === 0) {
    throw await diagnose(entity, repo, property, id, move, { key, pins }, options);
  }
  const row = await repo.findById(id, options);
  if (row === null) throw notFound(entity.$name, String(id));
  return row;
};
