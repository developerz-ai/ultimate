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
  // `mcp.ts` returns these three on `AdminToolResult.error` instead of throwing — a refusal an
  // agent reads, not a stack an operator reads. They stayed unregistered because of that, so
  // `x errors explain X_ADMIN_DENIED` refused a code the admin had just answered with. A code
  // an agent can be handed is a code the package owns, whichever way it travels.
  'X_ADMIN_DENIED',
  'X_ADMIN_TOOL_FORBIDDEN',
  'X_ADMIN_INVALID',
  // The two ways a `pages:` entry can be wrong. Both are thrown by `defineAdmin` at declaration,
  // not on the first request: an admin page that is public, or one that shadows a generated
  // screen, is a defect the author must never be able to deploy.
  'X_ADMIN_PAGE_UNGUARDED',
  'X_ADMIN_PAGE_PATH_INVALID',
  // `AdminAction.name` addresses one handler in three places at once — the MCP tool name, the
  // default label key, and `callAdminTool`'s lookup. Two actions sharing it is refused where the
  // admin is DECLARED, so an app that never wires MCP still cannot ship the ambiguity.
  'X_ADMIN_ACTION_DUPLICATE',
  'X_ADMIN_REPO_UNBOUND',
  'X_ADMIN_FILTER_INVALID',
  'X_ADMIN_ACTION_NOT_APPLICABLE',
  'X_ADMIN_MOUNT_MISSING',
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
  X_ADMIN_DENIED: 'the actor may not use this admin surface',
  X_ADMIN_TOOL_FORBIDDEN: 'an admin MCP tool was called without permission',
  X_ADMIN_INVALID: "an admin tool's arguments failed the resource schema",
  X_ADMIN_PAGE_UNGUARDED: 'a custom admin page declared no permissions',
  X_ADMIN_PAGE_PATH_INVALID: 'a custom admin page has an unusable or already-taken path',
  X_ADMIN_ACTION_DUPLICATE: 'two admin actions share one name',
  X_ADMIN_REPO_UNBOUND: 'an admin resource has no database handle to read rows through',
  X_ADMIN_FILTER_INVALID:
    'an admin list was asked for a filter, sort or scope its resource does not derive',
  X_ADMIN_ACTION_NOT_APPLICABLE: 'an admin action was run on a row its when() rule excludes',
  X_ADMIN_MOUNT_MISSING: 'an admin batch job ran in a process that never declared its admin',
};

// One unconditional call, so a second package claiming one of admin's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(ADMIN_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`,
// which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
// `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE ROW,
// which has no anchor. The `https://ultimate.dev/errors/<code>` links this file built until 9.x
// answered 404, host included, on every error it has ever thrown; restating the replacement here
// would be the same constant in eight places waiting to drift again.

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
    });
  }
}

/**
 * Two registered actions carry one `name`. Refused at `defineAdmin`, not at the first call: the
 * name is the MCP tool name, the default label key AND the key `callAdminTool` resolves a handler
 * by, so a collision is a call that succeeds against the wrong action and reports nothing.
 */
export class AdminActionDuplicateError extends UltimateError {
  constructor(input: { name: string; entities: readonly string[] }) {
    const where = input.entities.length > 0 ? input.entities.join(' and ') : 'the global toolbar';
    super({
      code: 'X_ADMIN_ACTION_DUPLICATE',
      cause: `two admin actions are named "${input.name}" (on ${where}); an action name addresses one handler`,
      // The convention the framework's own examples already follow, made into the instruction:
      // an entity-qualified name is unique by construction.
      fix: `rename one in defineAdmin's actions — name: '<entity>.${input.name}' — so "${input.name}" belongs to one of them`,
    });
  }
}

/**
 * An action reached the admin without a policy — the button would be an open door.
 *
 * The subject's NAME goes in the cause and the permission's SHAPE goes in the fix: `can()` takes
 * `resource:verb` (`Permission` is `` `${string}:${string}` ``), and `subject` is an export name,
 * so the `can('<the action name>')` this used to emit was a paste that could not compile. No
 * `allow()` branch, unlike action's and query's twin: an unguarded admin operation is the one
 * thing this code exists to refuse.
 */
export class AdminPolicyMissingError extends UltimateError {
  constructor(input: { subject: string; kind: 'action' | 'resource' }) {
    super({
      code: 'X_ADMIN_POLICY_MISSING',
      cause: `${input.kind} "${input.subject}" is exposed in the admin with no policy`,
      fix: `add \`policy: can('<resource>:<verb>')\` to the ${input.kind} "${input.subject}" — a permission your definePermissions() call declares, never the ${input.kind}'s own name`,
    });
  }
}

/**
 * A resource with nothing to read rows through. Refused where the admin is DECLARED: the routes
 * of a repo-less resource would mount, render their chrome, and fail on the first row they ask for.
 */
export class AdminRepoUnboundError extends UltimateError {
  constructor(input: { entity: string; handles: readonly string[] }) {
    const carried = input.handles.length > 0 ? input.handles.join(', ') : 'none';
    super({
      code: 'X_ADMIN_REPO_UNBOUND',
      cause: `the admin resource "${input.entity}" has no repo: defineAdmin() was given no db handle that carries it (tables in the handle: ${carried}) and no resources.${input.entity}.repo`,
      fix: `pass the app's handle once: defineAdmin({ entities, db })   # with "${input.entity}" in the database() call that built db`,
    });
  }
}

/**
 * A list was asked for something its resource does not derive: a filter on a field that is not
 * one, an operator the field's shape has no meaning for, a value that is not the column's type, a
 * sort on an unsortable column, a scope nobody declared. Raised for a URL, an MCP call and a
 * `scopes:` / `rows:` declaration alike — an ignored parameter is a list that silently shows
 * every row to someone who asked for some of them.
 */
export class AdminFilterInvalidError extends UltimateError {
  constructor(input: {
    entity: string;
    /** What was asked for, as the caller spelled it: `f.colour`, `sort=body:asc`, `scope=mine`. */
    asked: string;
    cause: string;
    /** What the resource DOES answer, in the caller's own spelling. */
    known: readonly string[];
  }) {
    const known = input.known.length > 0 ? input.known.join(', ') : 'none';
    super({
      code: 'X_ADMIN_FILTER_INVALID',
      cause: `${input.entity}: "${input.asked}" ${input.cause} (this list answers: ${known})`,
      // The manifest records every resource's filters, sorts and scopes, so the command prints the
      // list this error names — for the resource, and for every other one.
      fix: `x manifest --json   # admin[].resources lists the filters, sorts and scopes of "${input.entity}"`,
    });
  }
}

/**
 * An action was run on a row its `when()` excludes. The button was never rendered for that row —
 * so this is a stale page (the row changed state since it was drawn) or a forged call — and the
 * gate answers it rather than the handler: a hidden button is not an authorization.
 */
export class AdminActionNotApplicableError extends UltimateError {
  constructor(input: { action: string; entity: string; id: string | null }) {
    const row = input.id === null ? 'no row at all' : `the row "${input.id}"`;
    super({
      code: 'X_ADMIN_ACTION_NOT_APPLICABLE',
      cause: `the admin action "${input.action}" does not apply to ${row} of "${input.entity}": its when() rule answered false for the row as it is now`,
      fix: `x manifest --json   # admin[].resources lists "${input.action}" with when: true — re-read the row (the detail page, or the admin.${input.entity}.read tool) and run it only while that rule holds`,
    });
  }
}

/**
 * A queued batch chunk was claimed by a process that declared no admin at the path the batch was
 * queued from. The worker role imports the API index and not the document graph, so an admin
 * declared only from a page module does not exist there — and neither do its actions.
 */
export class AdminMountMissingError extends UltimateError {
  constructor(input: { basePath: string; mounted: readonly string[] }) {
    const mounted = input.mounted.length > 0 ? input.mounted.join(', ') : 'none';
    super({
      code: 'X_ADMIN_MOUNT_MISSING',
      cause: `an admin.batch job was claimed by a process with no admin declared at "${input.basePath}" (admins declared here: ${mounted}), so the action it names has no handler to run`,
      fix: 'import the module that calls defineAdmin() from apps/web/api/index.ts, so the worker role loads it; then x verify --only manifest',
    });
  }
}

/**
 * A `pages:` entry with an empty permission list. Refused where it is written, because the
 * alternative is an unauthenticated admin screen that `x verify` is perfectly happy with — the
 * route table would carry `permissions: []` and the emitted `defineRoute` would have no policy.
 */
export class AdminPageUnguardedError extends UltimateError {
  constructor(input: { path: string }) {
    super({
      code: 'X_ADMIN_PAGE_UNGUARDED',
      cause: `the admin page "${input.path}" declares no permissions, so nothing gates it`,
      fix: `add permissions: ['${input.path.replace(/^\//, '').split('/')[0] ?? 'ops'}:read'] to the pages entry for "${input.path}"`,
    });
  }
}

/** A page path that cannot be mounted: not rooted, malformed, or already served. */
export class AdminPagePathInvalidError extends UltimateError {
  /**
   * `subject` names WHICH declaration owns the bad path — `'page'` by default, `'resource'` when
   * two resources claim one URL. One code, because it is one failure (an admin URL with more than
   * one claimant), and a reader told "page path" while looking at a `resources:` entry goes to the
   * wrong file.
   */
  constructor(input: { path: string; cause: string; fix: string; subject?: string }) {
    super({
      code: 'X_ADMIN_PAGE_PATH_INVALID',
      cause: `the admin ${input.subject ?? 'page'} path "${input.path}" ${input.cause}`,
      fix: input.fix,
    });
  }
}

/**
 * A `/_x` panel needs a fact the framework cannot introspect on its own — request traces,
 * caught mail, the read-only SQL tool, the committed manifest. Thrown instead of drawing an
 * empty panel, because an empty panel reads as "nothing happened".
 */
export class DevSourceUnavailableError extends UltimateError {
  constructor(input: { source: string; panel: string; wiring?: string }) {
    super({
      code: 'X_NOT_IMPLEMENTED',
      cause: `the /_x ${input.panel} panel needs the "${input.source}" source, which is not wired in this process`,
      // `wiring`, when supplied, replaces the whole `defaultDevSources(...)` argument text —
      // the default `hooks: { <source> }` phrasing is only valid when the source really is a
      // `DevSources` key. "authz + actors" is not one; it is two `DevSourceOptions` fields, so
      // that call site passes its own `wiring` rather than render `hooks: { authz + actors }`,
      // which is not syntax an agent could run.
      fix: `devDashboard({ sources: defaultDevSources(${input.wiring ?? `{ hooks: { ${input.source} } }`}) })`,
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
