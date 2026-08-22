// The one derived question a SURFACE asks of a policy tree: can an anonymous caller be allowed at
// all. Apart from `policy.ts` so each file stays one responsibility — that one CONSTRUCTS trees,
// this one projects a single boolean out of a built one — and in this package rather than in the
// surfaces, because the answer is a property of the combinators and a copy per surface drifts from
// them the first time one changes.
import type { Policy, PolicyKind } from './policy';

/**
 * Whether an ANONYMOUS caller can be allowed by this policy — what a surface derives its
 * "does this route need a session" flag from. `policy.kind === 'allow'` is the read this
 * replaces, and it looked at the ROOT combinator only: `or(allow(), can('x:y'))` answered
 * "needs a session", so `@ultimat3/http`'s auth stage 401'd a caller the policy itself ALLOWS,
 * while the MCP tool and the job surface let that same caller through the same object. One
 * policy, a different answer per surface, which is the thing this package exists to prevent.
 *
 * **EXACT for `actor === null`, not a heuristic.** With no actor `can()` short-circuits on the
 * actor check before its predicate ever runs, and `allow()`/`deny()` ignore their arguments
 * entirely — so no predicate is consulted and the tree alone decides. It lives in THIS package
 * for that reason: the answer is a property of the combinators `policy.ts` declares, and a copy in
 * a surface package would drift from them the first time one changes.
 *
 * `true` never means "unguarded". It says only that the 401 is not the stage's to raise; the
 * surface still evaluates the policy through `enforce()`.
 */
export const admitsAnonymous = <I = unknown, R = unknown>(policy: Policy<I, R>): boolean =>
  anonymousOutcome(policy) === 'allowed';

/**
 * Three-valued, because `not()` needs the distinction: it PROPAGATES `X_UNAUTHENTICATED` rather
 * than inverting it, so `not(can('order:internal'))` denies an anonymous caller while
 * `not(deny(…))` allows one.
 */
type AnonymousOutcome = 'allowed' | 'denied' | 'unauthenticated';

/** The two fields the walk reads, so every `Policy<I, R>` satisfies it whatever its arguments. */
interface PolicyTree {
  readonly kind: PolicyKind;
  readonly children: readonly PolicyTree[];
}

/**
 * Exhaustive over `PolicyKind` by construction: a seventh kind is a missing-key TYPE error here,
 * never a silent "needs a session" on every route guarded by it. The import of `PolicyKind` is
 * what makes that hold across the split — a local union would be the copy this file exists not to
 * be.
 */
const OUTCOME_BY_KIND = Object.freeze<Record<PolicyKind, (policy: PolicyTree) => AnonymousOutcome>>(
  {
    allow: () => 'allowed',
    deny: () => 'denied',
    // `can()` denies with X_UNAUTHENTICATED before its predicate, for every permission.
    permission: () => 'unauthenticated',
    // First non-allowance wins, left to right — `and`'s own short-circuit.
    and: (policy) => {
      for (const child of policy.children) {
        const outcome = anonymousOutcome(child);
        if (outcome !== 'allowed') return outcome;
      }
      return 'allowed';
    },
    // First allowance wins; if none allow, `or` reports the LAST denial.
    or: (policy) => {
      let last: AnonymousOutcome = 'denied';
      for (const child of policy.children) {
        last = anonymousOutcome(child);
        if (last === 'allowed') return 'allowed';
      }
      return last;
    },
    not: (policy) => {
      const inner = policy.children[0];
      // A `not` with no child cannot come from `not()`; refusing anonymous is the safe reading.
      if (inner === undefined) return 'unauthenticated';
      const outcome = anonymousOutcome(inner);
      if (outcome === 'allowed') return 'denied';
      return outcome === 'unauthenticated' ? 'unauthenticated' : 'allowed';
    },
  },
);

function anonymousOutcome(policy: PolicyTree): AnonymousOutcome {
  // `Object.hasOwn`, never the read alone: `kind` is a field of a plain object, so a foreign
  // `Policy` can carry any string — and `OUTCOME_BY_KIND['valueOf']` is a function off the
  // prototype chain that THROWS when called with no receiver, which would kill a route
  // projection at mount. An unrecognised kind requires authentication.
  const decide = Object.hasOwn(OUTCOME_BY_KIND, policy.kind)
    ? OUTCOME_BY_KIND[policy.kind]
    : undefined;
  return decide === undefined ? 'unauthenticated' : decide(policy);
}
