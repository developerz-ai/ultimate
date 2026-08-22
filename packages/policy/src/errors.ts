// The policy layer's stable error codes. `X_POLICY_MISSING` is enforced by the TYPE system,
// not by a throw: `ActionDef.policy` is a required field (`@ultimat3/action`'s `action.ts`), so
// an action with no policy never compiles. The code and its factory stay published for a
// declaration site that cannot express the requirement in a type — a config-driven route table,
// a policy resolved by name — and `policyMissing()` is how such a site says it.
import { nearestName, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const POLICY_ERROR_CODES = [
  'X_FORBIDDEN',
  'X_POLICY_MISSING',
  'X_PERMISSION_UNKNOWN',
  'X_ROLE_REDEFINED',
] as const;

export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number];

export const POLICY_ERROR_TITLES: Readonly<Record<PolicyErrorCode, string>> = {
  X_FORBIDDEN: 'policy denied this actor',
  X_POLICY_MISSING: 'an action was declared without a policy',
  X_PERMISSION_UNKNOWN: 'permission string is not in the permission set',
  X_ROLE_REDEFINED: 'two modules define the same role differently',
};

// This package OWNS X_FORBIDDEN — http, auth, ai, realtime and every other surface adapter throw
// it and none of them declare a title for it. One authz code, one title, so every surface renders
// the same string. Registered unconditionally: a second package claiming one of these codes is a
// bug the registry must surface as X_ERROR_CODE_DUPLICATE, not absorb into a silent first-wins.
registerErrorCodes(
  Object.fromEntries(Object.entries(POLICY_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export class PolicyError extends UltimateError {
  override readonly name = 'PolicyError';

  constructor(init: { code: PolicyErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
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
