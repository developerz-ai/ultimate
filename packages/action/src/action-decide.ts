/**
 * `decide(rows)` for a handler: the action's OWN policy, asked once per row on the surface the
 * call came in on. Bound here from the declaration, so the handler holds a function of rows alone
 * and has no parameter through which to name another rule — skip-denied or abort-all stays its own.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import { codeOf, evaluateEach, PRIMITIVE_POLICY_SURFACES, reasonOf } from '@ultimat3/policy';
import type { ActionPolicy, Surface } from './policy-gate';

/** A row the action's policy refused, with the code and reason it would have refused the call. */
export interface ActionRowDenial<TRow> {
  readonly row: TRow;
  readonly code: string;
  readonly reason: string;
}

export interface ActionDecision<TRow> {
  /** In the order given. Only a row whose evaluation was exactly `allowed: true` lands here. */
  readonly allowed: readonly TRow[];
  /** In the order given: a missing (`null`/`undefined`) row, or one the policy refused. */
  readonly denied: readonly ActionRowDenial<TRow>[];
}

/** Rows only: the policy, the actor, the input and the surface are the call's, never the caller's. */
export type ActionDecide<TRow> = (rows: readonly TRow[]) => ActionDecision<TRow>;

/** Safe to log: names no row. */
const MISSING_ROW = 'no row: a missing row is never evidence of permission';

export interface DecideSubject {
  readonly actor: Actor | null;
  /** The parsed input — the same object `handle` and the call's own guard saw. */
  readonly input: unknown;
  readonly ctx: Ctx;
}

/**
 * The surface is read off `PRIMITIVE_POLICY_SURFACES`, the table `guardPrimitive` judges the call
 * itself by, so a row's decision event names the surface the call's own decision did. Every
 * evaluation goes through `evaluateEach` → `evaluate`: one decision event per row, no second path.
 */
export function decideFor<TRow>(
  policy: ActionPolicy<TRow>,
  subject: DecideSubject,
  surface: Surface,
): ActionDecide<TRow> {
  const target = PRIMITIVE_POLICY_SURFACES.action[surface];
  return (rows) => {
    // A missing row is never asked: `evaluate()` hands the predicate `null` for it, and `null` is
    // the CALL-level question a batch rule admits — so a lookup that found nothing would borrow
    // the call's allow. Denied here instead, the way an action's rule must read `row: null`.
    const present = rows.filter((row) => row !== null && row !== undefined);
    const evaluations = evaluateEach(
      policy,
      { input: subject.input, actor: subject.actor, rows: present, ctx: subject.ctx },
      { surface: target },
    );
    const allowed: TRow[] = [];
    const denied: ActionRowDenial<TRow>[] = [];
    let next = 0;
    for (const row of rows) {
      if (row === null || row === undefined) {
        denied.push({ row, code: 'X_FORBIDDEN', reason: MISSING_ROW });
        continue;
      }
      const evaluation = evaluations[next];
      next += 1;
      // `=== true`, never truthiness: a hand-built policy whose `run` answers `{ allowed: 'yes' }`
      // must not move a row into `allowed` — fail closed, the way `isDecision` does for a predicate.
      if (evaluation?.allowed === true) allowed.push(row);
      else
        denied.push({
          row,
          code: (evaluation && codeOf(evaluation.decision)) ?? 'X_FORBIDDEN',
          reason: (evaluation && reasonOf(evaluation.decision)) ?? 'denied',
        });
    }
    return Object.freeze({ allowed: Object.freeze(allowed), denied: Object.freeze(denied) });
  };
}
