// The policy layer's stable error codes. `X_POLICY_MISSING` is deliberately a build
// error rather than a runtime default: an action with no policy is not "public", it
// is unfinished.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const POLICY_ERROR_CODES = [
  'X_FORBIDDEN',
  'X_POLICY_MISSING',
  'X_PERMISSION_UNKNOWN',
] as const;

export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number];

export const POLICY_ERROR_TITLES: Readonly<Record<PolicyErrorCode, string>> = {
  X_FORBIDDEN: 'policy denied this actor',
  X_POLICY_MISSING: 'an action was declared without a policy',
  X_PERMISSION_UNKNOWN: 'permission string is not in the permission set',
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

/** `reason` comes from a decision and is always safe to log: no row data, no PII. */
export const forbidden = (label: string, reason: string): PolicyError =>
  new PolicyError({
    code: 'X_FORBIDDEN',
    cause: `${label} denied: ${reason}`,
    fix: `x policy explain ${label} --json   # shows which clause decided and why`,
  });

export const policyMissing = (subject: string): PolicyError =>
  new PolicyError({
    code: 'X_POLICY_MISSING',
    cause: `${subject} has no policy; an action without a policy is a build error, not a public endpoint`,
    fix: `add policy: can('<resource>:<verb>') to ${subject}, or allow('public') to say so explicitly`,
  });

export const permissionUnknown = (permission: string, known: readonly string[]): PolicyError =>
  new PolicyError({
    code: 'X_PERMISSION_UNKNOWN',
    cause: `"${permission}" is not in the permission set (${known.length} known)`,
    fix: `add '${permission}' to definePermissions([...]) — or fix the typo`,
  });
