// The policy layer's stable error codes. `X_POLICY_MISSING` is enforced by the TYPE system,
// not by a throw: `ActionDef.policy` is a required field (`@ultimat3/action`'s `action.ts`), so
// an action with no policy never compiles. The code and its factory stay published for a
// declaration site that cannot express the requirement in a type — a config-driven route table,
// a policy resolved by name — and `policyMissing()` is how such a site says it.
import {
  type ErrorRetry,
  nearestName,
  registerErrorCodes,
  registerErrorRetry,
  renderCauseValue,
  UltimateError,
} from '@ultimat3/core';

export const POLICY_ERROR_CODES = [
  'X_FORBIDDEN',
  'X_POLICY_MISSING',
  'X_PERMISSION_UNKNOWN',
  'X_POLICY_CLAUSE_EMPTY',
  'X_POLICY_SURFACE_UNKNOWN',
  'X_ROLE_REDEFINED',
] as const;

export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number];

export const POLICY_ERROR_TITLES: Readonly<Record<PolicyErrorCode, string>> = {
  X_FORBIDDEN: 'policy denied this actor',
  X_POLICY_MISSING: 'an action was declared without a policy',
  X_PERMISSION_UNKNOWN: 'permission string is not in the permission set',
  X_POLICY_CLAUSE_EMPTY: 'a policy combinator was built with no clauses',
  X_POLICY_SURFACE_UNKNOWN: 'enforce() was handed a surface no adapter answers to',
  X_ROLE_REDEFINED: 'two modules define the same role differently',
};

// This package OWNS X_FORBIDDEN — http, auth, ai, realtime and every other surface adapter throw
// it and none of them declare a title for it. One authz code, one title, so every surface renders
// the same string. Registered unconditionally: a second package claiming one of these codes is a
// bug the registry must surface as X_ERROR_CODE_DUPLICATE, not absorb into a silent first-wins.
registerErrorCodes(
  Object.fromEntries(Object.entries(POLICY_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/**
 * Every one of them, LISTED rather than left to the `terminal` default — the call
 * `@ultimat3/jobs`' webhook block already makes, and for its reason: `classifyThrown` reads an
 * unregistered code carrying `terminal` as UNCLASSIFIED, so the attempt count governs and a job
 * spends its whole retry policy re-proving an answer no attempt can change.
 *
 * `X_FORBIDDEN` is the one that matters, and core's own `ErrorRetry` doc comment names its case
 * verbatim — *"the same call will fail the same way forever (a config fault, a validation error, a
 * permission denial)"*. The same actor, the same input and the same row decide the same way on
 * attempt five; the four declaration faults beside it cannot change between attempts at all,
 * because each is raised while a module is still evaluating.
 *
 * Registered here rather than by the surfaces that THROW `X_FORBIDDEN` (http, auth, ai, realtime)
 * for the reason the title is: this package owns the code, and a second package registering a
 * different classification for it is a conflict `registerErrorRetry` raises rather than absorbs.
 *
 * Written out key by key over a CLOSED `Record<PolicyErrorCode, …>` rather than derived from
 * `POLICY_ERROR_CODES` with a `.map`: a derivation classifies a new code by accident, and the one
 * question worth asking of a code is whether trying it again could ever answer differently. A code
 * added above with no row here is a missing-key TYPE error, which is the enforcement.
 */
const POLICY_ERROR_RETRY = Object.freeze<Record<PolicyErrorCode, ErrorRetry>>({
  X_FORBIDDEN: 'terminal',
  X_POLICY_MISSING: 'terminal',
  X_PERMISSION_UNKNOWN: 'terminal',
  X_POLICY_CLAUSE_EMPTY: 'terminal',
  X_POLICY_SURFACE_UNKNOWN: 'terminal',
  X_ROLE_REDEFINED: 'terminal',
});

registerErrorRetry(POLICY_ERROR_RETRY);

export class PolicyError extends UltimateError {
  override readonly name = 'PolicyError';

  constructor(init: { code: PolicyErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
    });
  }
}

/**
 * A label `x policy explain` can resolve: one declared permission, `<resource>:<verb>`.
 *
 * Every other `Policy` renders its label as a DESCRIPTION — `and(post:publish, org:administer)`,
 * `not(post:publish)`, `allow`, `deny(read-only mode)` — and `knownPolicySubjects()` holds
 * permissions, action names and route paths, none of which those match. Interpolating one produced
 * `x policy explain and(post:publish, org:administer)`, reproduced in `examples/dummy` as
 * `X_DECLARATION_UNKNOWN`: a fix line whose only effect is a second error.
 */
const BARE_PERMISSION = /^[a-z0-9_-]+:[a-z0-9_-]+$/;

/** `reason` comes from a decision and is always safe to log: no row data, no PII. */
export const forbidden = (label: string, reason: string): PolicyError =>
  new PolicyError({
    code: 'X_FORBIDDEN',
    cause: `${label} denied: ${reason}`,
    // `x policy list --json` is what `X_DECLARATION_UNKNOWN`'s own fix falls back to, so a reader
    // who follows either one lands in the same place.
    fix: BARE_PERMISSION.test(label)
      ? `x policy explain ${label} --json   # shows which clause decided and why`
      : `x policy list --json   # then: x policy explain <permission> --json for the clause that decided`,
  });

export const policyMissing = (subject: string): PolicyError =>
  new PolicyError({
    code: 'X_POLICY_MISSING',
    cause: `${subject} has no policy; an action without a policy is a build error, not a public endpoint`,
    fix: `add policy: can('<resource>:<verb>') to ${subject}, or allow('public') to say so explicitly`,
  });

/**
 * Both declaration sites are named because the fix is always "one of these two wins", and which
 * two is the only thing the author does not already know.
 */
export const roleRedefined = (role: string, first: string, second: string): PolicyError =>
  new PolicyError({
    code: 'X_ROLE_REDEFINED',
    cause: `role "${role}" is defined twice with different grants — first at ${first}, again at ${second}`,
    fix: `x policy list --json   # then keep ONE definition of "${role}": rename the second, or fold its grants into the first`,
  });

/**
 * The nearest declared permission comes FIRST, and the declare-it path second.
 *
 * The other order is what shipped: `add 'billing:wirte' to definePermissions([...])` reads as an
 * instruction to declare the typo, and a permission nothing grants and nothing enforces is a
 * silent hole — `assertPermission` then passes, every `can('billing:wirte')` denies, and the
 * failure moves from this throw to a page that renders empty. Only the generated `policy.test.ts`
 * caught it. A typo is by far the likelier of the two readings, so it leads.
 */
export const permissionUnknown = (permission: string, known: readonly string[]): PolicyError => {
  const nearest = nearestName(permission, known);
  return new PolicyError({
    code: 'X_PERMISSION_UNKNOWN',
    // The COUNT, never the set: an app with 200 permissions would bury the fix line under names
    // nobody asked for, and `x policy list --json` is one command away.
    cause: `"${permission}" is not in the permission set (${known.length} known)`,
    fix:
      nearest === undefined
        ? `add '${permission}' to definePermissions([...]) if it is genuinely new — otherwise x policy list --json shows the ${known.length} already declared`
        : `use '${nearest}', the nearest declared permission — or add '${permission}' to definePermissions([...]) if it is genuinely new`,
  });
};

/**
 * A combinator built with no clauses, refused where it is WRITTEN — the call
 * `@ultimat3/scraping`'s `allowHosts: []` and `discriminated-union.ts`'s unroutable member both
 * already make: a declaration that is wrong for every input is wrong at its first import, not at
 * the request that discovers it.
 *
 * `and()` is the dangerous half and the reason this code exists. With no clauses its loop finds
 * nothing to deny and answers ALLOWED, so `and(...requiredCaps.map(can))` over a list that
 * filtered to empty is a policy admitting an ANONYMOUS caller on all four surfaces — and
 * `meta.auth` derives from `admitsAnonymous`, so `@ultimat3/http` does not 401 first either. There
 * was no diagnostic to follow: the label renders as `and()`.
 *
 * `or()` is refused for symmetry and for axiom 1, not for safety: it denies, which fails closed,
 * but it denies with "no clause allowed this actor" — a reason naming no clause, which is a denial
 * nobody can debug. `deny('<reason>')` is the spelling that says the same thing WITH one.
 *
 * Both fixes name the explicit spelling, so refusing costs a caller nothing they cannot say
 * another way.
 */
export const emptyClauseList = (combinator: 'and' | 'or'): PolicyError =>
  new PolicyError({
    code: 'X_POLICY_CLAUSE_EMPTY',
    cause:
      combinator === 'and'
        ? 'and() was built with no clauses, so it allows every actor — anonymous callers included — on every surface'
        : 'or() was built with no clauses, so it denies every actor and names no clause that could have allowed one',
    fix:
      combinator === 'and'
        ? "write allow('public') if every caller may act — otherwise pass the clauses the list was meant to hold: and(can('<resource>:<verb>'), …)"
        : "write deny('<why nobody may act>') if nobody may act — otherwise pass the clauses the list was meant to hold: or(can('<resource>:<verb>'), …)",
  });

/**
 * `enforce()` was handed a surface with no adapter. Thrown rather than denied, because the value
 * this reports on is one an index would have resolved to something: every object literal inherits
 * `Object.prototype`, so `adapters['valueOf']` answers a function and `adapters['constructor']`
 * answers a constructor. Both are truthy, so the dispatcher fails CLOSED and returns a
 * `SurfaceDenial` no caller can read — a refusal with no code and no reason, which is worse than
 * the refusal it is standing in for.
 *
 * `known` comes from the adapter table itself, so a fifth surface joins this fix line by existing.
 * The received value goes through `renderCauseValue` and never `${}`: the parameter is typed
 * `Surface`, and the call site this guard exists for is one no type reached.
 */
export const surfaceUnknown = (surface: unknown, known: readonly string[]): PolicyError =>
  new PolicyError({
    code: 'X_POLICY_SURFACE_UNKNOWN',
    cause: `enforce() was handed surface ${renderCauseValue(surface)}, which no policy adapter answers to`,
    fix: `pass one of ${known.join(', ')} — e.g. enforce('${known[0] ?? 'http'}', policy, args)`,
  });
