// One actor's verdict on a policy, with or without the request's input: the row both `x policy
// explain` and the `/_x` policy panel draw. Without input, a predicate that READS input is
// `needs-input` — never the deny a stand-in `{}` produced. `policyMatrix` stays the only decider.

import type { MatrixRow, NamedActor, Policy } from '@ultimat3/policy';
import { decideBeforeInput, policyMatrix, reasonOf } from '@ultimat3/policy';

/**
 * `needs-input` is NOT a denial: the actor passes every clause that reads only the actor, and a
 * predicate then read the request's input — which this command was not given. Reported as a deny
 * it sent the reader to edit a correct policy: every input-scoped rule (all that `x g resource`
 * writes) read "predicate returned false" about the admin who had just succeeded over HTTP.
 */
export type ExplainVerdict = 'allow' | 'deny' | 'needs-input';

/** A `MatrixRow` that can also say "not decided". `allowed` is `null` exactly when it was not. */
export interface ExplainRow extends Omit<MatrixRow, 'allowed'> {
  readonly verdict: ExplainVerdict;
  readonly allowed: boolean | null;
}

export const decided = (row: MatrixRow): ExplainRow => ({
  ...row,
  verdict: row.allowed ? 'allow' : 'deny',
});

/**
 * A stand-in for the input nobody supplied, which records being READ. Every trap a predicate can
 * reach it through answers "nothing there" — what `{}` answered — and sets the flag, so a verdict
 * that came out of reading it is known to be a verdict about no request at all.
 */
function absentInput(): { readonly value: object; read(): boolean } {
  let touched = false;
  const touch = <T>(answer: T): T => {
    touched = true;
    return answer;
  };
  const value = new Proxy(
    {},
    {
      get: () => touch(undefined),
      has: () => touch(false),
      ownKeys: () => touch([]),
      getOwnPropertyDescriptor: () => touch(undefined),
    },
  );
  return { value, read: () => touched };
}

/**
 * One actor with no input to hand the policy. The before-input gate (`decideBeforeInput`, the one
 * the HTTP surface runs before it parses a body) says whether a predicate has to run for this
 * actor at all; when one does, the full evaluation runs over `absentInput()`, and a predicate
 * that read it — or threw reading it — is `needs-input`, never a deny. A predicate that reads
 * only the actor decides as it would on a request. `policyMatrix` stays the only decider.
 */
export function rowWithoutInput(policy: Policy, entry: NamedActor): ExplainRow {
  const input = absentInput();
  let row: MatrixRow | undefined;
  try {
    row = policyMatrix(policy, { actors: [entry], input: input.value }).rows[0];
  } catch {
    row = undefined;
  }
  const before = decideBeforeInput(policy, { actor: entry.actor });
  if (row !== undefined && !(before === undefined && input.read())) return decided(row);
  // Decided whatever the input is, and a predicate past the deciding clause threw on the stand-in.
  if (before !== undefined) {
    const { allowed } = before;
    return decided({ actor: entry.name, allowed, reason: reasonOf(before), deciding: null });
  }
  const clause = row?.deciding ?? policy.label;
  return {
    actor: entry.name,
    verdict: 'needs-input',
    allowed: null,
    deciding: row?.deciding ?? null,
    reason: `not denied — every actor-only clause passes, and ${clause} has a predicate that reads the request input`,
  };
}
