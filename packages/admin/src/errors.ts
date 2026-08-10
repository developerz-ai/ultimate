// The X_* codes owned by @ultimat3/admin. Every one names the exact edit that fixes it,
// because the two dashboards fail at boot (bad registry, bad mount) where an agent has no
// stack trace to reason from — only the message.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const ADMIN_OWNED_ERROR_CODES = [
  'X_ADMIN_ENTITY_UNKNOWN',
  'X_ADMIN_FIELD_UNSUPPORTED',
  'X_ADMIN_POLICY_MISSING',
  'X_DEV_DASHBOARD_IN_PROD',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s. `DevSourceUnavailableError` throws it; this package
 * neither titles nor registers it, because the owner's title is the only one that may exist.
 */
export const ADMIN_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const;

/** Every code admin can throw: the ones it owns plus the one it borrows. */
export const ADMIN_ERROR_CODES = [
  ...ADMIN_OWNED_ERROR_CODES,
  ...ADMIN_BORROWED_ERROR_CODES,
] as const;

export type AdminOwnedErrorCode = (typeof ADMIN_OWNED_ERROR_CODES)[number];
export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];

export const ADMIN_ERROR_TITLES: Readonly<Record<AdminOwnedErrorCode, string>> = {
  X_ADMIN_ENTITY_UNKNOWN: 'the admin references an entity that does not exist',
  X_ADMIN_FIELD_UNSUPPORTED: 'a column type the admin cannot render',
  X_ADMIN_POLICY_MISSING: 'an admin-exposed subject has no policy',
  X_DEV_DASHBOARD_IN_PROD: '/_x was mounted outside dev',
};

// One unconditional call, so a second package claiming one of admin's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(ADMIN_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

const docsFor = (code: AdminErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** A resource, nav item, or MCP tool named an entity the registry does not have. */
export class AdminEntityUnknownError extends UltimateError {
  constructor(input: { entity: string; known: readonly string[]; cause?: string }) {
    super({
      code: 'X_ADMIN_ENTITY_UNKNOWN',
      cause:
        input.cause ??
        `entity "${input.entity}" is not registered (registered: ${
          input.known.length > 0 ? input.known.join(', ') : 'none'
        })`,
      fix: `x g entity ${input.entity}   # then: x manifest`,
      docs: docsFor('X_ADMIN_ENTITY_UNKNOWN'),
    });
  }
}

/**
 * A column has no widget, or a value cannot be rendered safely in the widget it maps to.
 * Money arriving as a float and a timestamptz arriving without an IANA zone are the same
 * class of bug: the admin would render a number that is wrong for somebody.
 */
export class AdminFieldUnsupportedError extends UltimateError {
  constructor(input: { entity: string; field: string; cause: string; fix: string }) {
    super({
      code: 'X_ADMIN_FIELD_UNSUPPORTED',
      cause: `${input.entity}.${input.field}: ${input.cause}`,
      fix: input.fix,
      docs: docsFor('X_ADMIN_FIELD_UNSUPPORTED'),
    });
  }
}

/** An action reached the admin without a policy — the button would be an open door. */
export class AdminPolicyMissingError extends UltimateError {
  constructor(input: { subject: string; kind: 'action' | 'resource' }) {
    super({
      code: 'X_ADMIN_POLICY_MISSING',
      cause: `${input.kind} "${input.subject}" is exposed in the admin with no policy`,
      fix: `add policy: can('${input.subject}') to the ${input.kind} definition`,
      docs: docsFor('X_ADMIN_POLICY_MISSING'),
    });
  }
}

/**
 * A `/_x` panel needs a fact the framework cannot introspect on its own — request traces,
 * caught mail, the read-only SQL tool, the committed manifest. Thrown instead of drawing an
 * empty panel, because an empty panel reads as "nothing happened".
 */
export class DevSourceUnavailableError extends UltimateError {
  constructor(input: { source: string; panel: string }) {
    super({
      code: 'X_NOT_IMPLEMENTED',
      cause: `the /_x ${input.panel} panel needs the "${input.source}" source, which is not wired in this process`,
      fix: `devDashboard({ sources: defaultDevSources({ hooks: { ${input.source} } }) })`,
      docs: docsFor('X_NOT_IMPLEMENTED'),
    });
  }
}

/** `/_x` is a development tool: it prints SQL, policy traces, and caught mail. */
export class DevDashboardInProdError extends UltimateError {
  constructor(input: { role: string; env: string }) {
    super({
      code: 'X_DEV_DASHBOARD_IN_PROD',
      cause: `devDashboard() was called with role="${input.role}" env="${input.env}"; /_x exposes SQL, policy traces, and caught mail`,
      fix: 'delete the /_x mount from the production entrypoint; run `x dev` locally instead',
      docs: docsFor('X_DEV_DASHBOARD_IN_PROD'),
    });
  }
}

/** The three strings a failed admin request carries to the view. */
export interface AdminErrorParts {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
}

/**
 * A route hands a view the error as data, because it crossed a wire and lost its class. The
 * views render it through ui's `<ErrorState>`, which reads an UltimateError — so it is
 * rehydrated here rather than paraphrased into a second, drifting rendering.
 */
export function adminErrorFrom(parts: AdminErrorParts): UltimateError {
  return new UltimateError({ code: parts.code, cause: parts.cause, fix: parts.fix });
}
