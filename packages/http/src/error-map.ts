// The one place a framework error code becomes an HTTP status. A table, not a
// switch chain: adding a code elsewhere in the framework means adding a row here,
// and a missing row is a loud 500 rather than a silently wrong 200.
import { renderCauseValue } from '@ultimat3/core';
import { errorStatusInvalid, HTTP_ERROR_TITLES } from './errors';

/**
 * code -> status. Codes owned by other packages are listed here on purpose: HTTP
 * is the only layer that knows what a status means, so no other package should
 * ever hardcode one.
 */
export const ERROR_STATUS: Readonly<Record<string, number>> = {
  // @ultimat3/http
  X_ROUTE_NOT_FOUND: 404,
  X_METHOD_NOT_ALLOWED: 405,
  // The request line itself is unreadable, so there is nothing to route: 400, and never a 500 —
  // a malformed escape is the caller's typo, not this server's defect.
  X_PATH_INVALID: 400,
  X_BODY_INVALID: 422,
  X_UNAUTHENTICATED: 401,
  X_FORBIDDEN: 403,
  X_RATE_LIMITED: 429,
  X_BUILD_SKEW: 409,
  X_ROUTE_CONFLICT: 500,
  X_SERVER_NOT_STARTED: 500,
  X_PIPELINE_NO_RESPONSE: 500,
  // The request was answered and the answer could not be finished: the caller gets nothing usable
  // either way, so this is the server's failure, never the caller's.
  X_PIPELINE_FINALIZE_FAILED: 500,
  // Both are wiring bugs, never a caller's mistake: reading a cookie where no request exists,
  // and declaring a status the framework already owns. 500 is the honest answer to either.
  X_NO_REQUEST: 500,
  X_ERROR_STATUS_INVALID: 500,
  // Thrown while `app.config.ts` resolves, so no request is ever answered with it — the row exists
  // because a code with no status is a 500 anyway and this table is the closed one.
  X_CORS_CONFIG_INVALID: 500,
  // Thrown while the server is being constructed, so no request is ever answered with it either.
  // The row exists because this table is the closed one: a code missing from it is a 500 anyway,
  // and a code the framework owns must never fall through to the app's table.
  X_RATE_LIMIT_NOT_SHARED: 500,
  // Same construction-time class as the row above: a route and the config declare one bucket
  // differently, and the process refuses to start rather than pick.
  X_RATE_LIMIT_BUCKET_CONFLICT: 500,
  // Construction time as well: the limiter installed cannot enforce a bucket a route declares.
  X_RATE_LIMIT_BUCKET_UNBOUND: 500,
  // `defineHttpConfig` time, both of them: a declaration the deployment owes and did not make.
  X_RATE_LIMIT_SCOPE_UNSET: 500,
  X_TRUST_PROXY_UNSET: 500,
  // Raised by `toBucket` while a route or an action is being projected, never on the request.
  X_RATE_LIMIT_INVALID: 500,
  // The two the `admit` stage answers with, and the only 503s the pipeline produces. Both carry
  // `retry-after`: a shed request that does not say when to come back is a request that comes
  // back immediately, which is the load it was shed to avoid.
  X_DRAINING: 503,
  X_OVERLOADED: 503,
  // 403 and never 401: the caller IS authenticated — that is what makes the forged write work —
  // so a 401 would send a signed-in user to a sign-in page they are already past.
  X_CSRF_BLOCKED: 403,
  // @ultimat3/action — the code every primitive throws when the CALLER's input fails the schema
  // the primitive declared. 400 because that is what the published OpenAPI operation promises for
  // it, and because a missing row made a typo'd uuid a 500: the caller was told the server broke,
  // and the `error-map` stage reported the caller's mistake to the on-call monitor.
  X_INPUT_INVALID: 400,
  // A retried `Idempotency-Key` naming a different payload, or one still in flight. 409 because
  // that is what the action's own OpenAPI operation publishes for it — the runtime answered 500
  // while the document promised 409, and a client written against the spec read the framework
  // working exactly as designed as an outage.
  X_IDEMPOTENCY_CONFLICT: 409,
  // A blank or over-long `Idempotency-Key` HEADER, refused before the handler runs. 400 and not
  // the 422 a body gets: what failed is a parameter the OpenAPI operation publishes a `maxLength`
  // for, which is the same thing `X_INPUT_INVALID` is 400 for.
  X_IDEMPOTENCY_KEY_INVALID: 400,
  // 500, and deliberately not the 409 above. `IdempotencyReplayedFailureError` re-throws the FIRST
  // attempt's own code whenever the store recorded one, so this literal code is reached only when
  // that attempt failed carrying no code at all: an unclassified throw whose commit state nobody
  // knows. That is the server's to explain, and it is worth reporting.
  X_IDEMPOTENCY_REPLAYED_FAILURE: 500,
  // @ultimat3/auth — every one of these is reachable from a request: the OAuth route descriptors
  // are mounted by the app, and `authenticate` throws the session codes inside the pipeline. Without
  // a row each fell to 500, so a user pressing Cancel on a consent screen paged the on-call and a
  // provider this app never enabled read as an outage. `packages/auth/src/oauth-route.ts` answers
  // from this table's values when its descriptors are driven OUTSIDE a pipeline; the pin that keeps
  // the two identical is `scripts/oauth-route-status.test.ts`, since auth is this tier and cannot
  // import this package.
  X_SESSION_EXPIRED: 401,
  X_MFA_REQUIRED: 401,
  X_ACCOUNT_LOCKED: 429,
  X_API_KEY_INVALID: 401,
  X_OAUTH_STATE_INVALID: 400,
  X_OAUTH_TOKEN_INVALID: 400,
  X_OAUTH_PROVIDER_UNKNOWN: 404,
  X_OAUTH_DENIED: 403,
  // 502, not 500: the conversation that failed is with the provider's server, and the on-call
  // question "is it us or them?" is the one a status is read for.
  X_OAUTH_EXCHANGE_FAILED: 502,
  // 422 and not 400: the body parsed, the field is a string, and a policy rejected its CONTENT —
  // the same class as `X_BODY_INVALID` and `X_INVARIANT_VIOLATED` above. Unmapped, a visitor
  // choosing "password" at a signup form was reported to the on-call monitor as a server fault.
  X_PASSWORD_WEAK: 422,
  // @ultimat3/entity
  X_NOT_FOUND: 404,
  X_ENTITY_DUPLICATE: 409,
  X_INVARIANT_VIOLATED: 422,
  X_TENANCY_UNSCOPED: 500,
  X_DB_DRIFT: 500,
  // The three tenancy refusals, all 403, and all deliberately NOT the 404 `X_STORAGE_ORG_MISMATCH`
  // takes: that one answers 404 because a 403 on a KEY the caller supplied confirms the key exists.
  // These three name no resource and read no row — the comparison is the actor against an argument
  // (`X_TENANCY_ACTOR_MISMATCH`), the actor against nothing at all (`X_TENANCY_ACTOR_ORG_REQUIRED`),
  // or the actor's scopes at `crossTenant()` (`X_TENANCY_CROSS_DENIED`) — so the answer is the same
  // whether or not the other tenant's row exists, and a 404 would buy no secrecy for the lie.
  X_TENANCY_ACTOR_MISMATCH: 403,
  // 403 and never 401, for the reason `X_CSRF_BLOCKED` is one: the actor may be fully
  // authenticated and merely carry no org — a service actor minted without one — so a 401 sends a
  // signed-in caller to a sign-in page that cannot give them a tenant.
  X_TENANCY_ACTOR_ORG_REQUIRED: 403,
  X_TENANCY_CROSS_DENIED: 403,
  // @ultimat3/db — the constraints a request trips, both 409. db's own `fix:` for the unique
  // violation says "answer 409, which is what a raced signup is", and `X_ENTITY_DUPLICATE` — the
  // same event one layer up — is 409 above; a foreign key rides with it because both halves of it
  // are a conflict with the state that is there (the parent is missing, or the child still points
  // at it), which 422 describes only for the insert.
  X_DB_UNIQUE_VIOLATION: 409,
  X_DB_FOREIGN_KEY_VIOLATION: 409,
  // @ultimat3/policy
  X_POLICY_MISSING: 500,
  X_PERMISSION_UNKNOWN: 500,
  // @ultimat3/query — the read declares no id, so no cursor can name a position in it. The one
  // paging failure that is NOT the caller's: the fix is an edit to the read's own select, nothing
  // the client sends changes the answer, and the report to the on-call monitor is the point.
  X_QUERY_NOT_PAGEABLE: 500,
  // @ultimat3/i18n — a well-formed tag outside the set this app ships, asserted on a value the
  // caller supplied (`assertSupportedLocale`). 400 rather than 406: the http `locale` stage
  // negotiates `Accept-Language` and never throws, so the tag that reaches here came from a path,
  // query or body the caller wrote — the same place `X_IMAGE_QUERY_INVALID` comes from.
  X_LOCALE_UNSUPPORTED: 400,
  // @ultimat3/seo — a transform query the caller wrote, so the caller is the one who can fix it.
  X_IMAGE_QUERY_INVALID: 400,
  // @ultimat3/storage — every one of these is reachable from a route: `/media/*` already serves
  // objects, and a mounted `/_storage` serves signed reads and takes signed writes. Without a row
  // a missing image answers 500, which reads as an outage instead of a 404.
  X_STORAGE_NOT_FOUND: 404,
  X_STORAGE_PATH_UNSAFE: 400,
  X_STORAGE_TOO_LARGE: 413,
  X_STORAGE_TYPE_REJECTED: 415,
  X_STORAGE_CHECKSUM_MISMATCH: 422,
  X_STORAGE_URL_INVALID: 403,
  X_STORAGE_URL_EXPIRED: 410,
  // 409, not the 500 it fell through to: the object exists and the request is well formed — the
  // STATE is wrong. A validated upload lands under the quarantine segment and `promoteAttachment`
  // refuses it until the app's own scanner calls `releaseQuarantine`, which is a thing the caller
  // can do. A 500 would have read as "the server broke" for a workflow working exactly as built.
  X_STORAGE_QUARANTINED: 409,
  // 404, deliberately NOT 403: the org check fires before anything is read, so answering
  // "forbidden" would confirm that a key exists to the one caller who must not learn it.
  X_STORAGE_ORG_MISMATCH: 404,
  // @ultimat3/mail
  // The deployment configured no transport. It reaches a caller only through an inline
  // `send(…, { sync: true })` inside a request; the queued path dead-letters instead. A server-side
  // configuration fault either way, so 500 and never a 4xx — nothing the caller sent is wrong, and
  // this is exactly the condition somebody should be paged for.
  X_MAIL_CREDENTIAL_MISSING: 500,
  // @ultimat3/core
  // The caller asked for a format the pipeline cannot produce (`?f=avif`): the request names an
  // unsupported representation, which is 415 — not a 500, which would blame the server for it.
  X_IMAGE_UNSUPPORTED: 415,
  // A page token this server minted and the caller echoed back, and it did not verify — tampered,
  // or replayed against another read. The caller's value and the caller's repair ("request the
  // first page again"), so it belongs beside `X_IMAGE_QUERY_INVALID` at 400 and not at 500.
  X_CURSOR_INVALID: 400,
  // Raised by `markReady()` while a role STARTS, in a process whose lifecycle already drained — so
  // no request is ever answered with it, and the row exists for the reason the construction-time
  // rows above do: this table is the closed one, and a code with no row is a 500 anyway.
  X_LIFECYCLE_DRAINED: 500,
  X_NOT_IMPLEMENTED: 501,
  X_TIMEOUT: 504,
  X_ABORTED: 499,
  X_INTERNAL: 500,
};

export const DEFAULT_STATUS = 500;

/**
 * Statuses for codes the APP owns. The table above is closed — it has to be, it is the
 * framework's own contract — and every code outside it fell to 500, so a wrong password was an
 * incident: `pipeline.ts` reports `status >= 500` to the error monitor, and a user's typo paged
 * whoever was on call. This is the app's half of the same table, kept separate so a registration
 * can never move `X_FORBIDDEN` off 403.
 */
const APP_ERROR_STATUS = new Map<string, number>();

/**
 * Declare the status for the codes this app throws. Call it once at boot, beside the module
 * that declares the codes — importing that module IS the registration, the convention
 * `registerActions` and `registerErrorCodes` already use.
 *
 * ```ts
 * registerErrorStatus({ X_CREDENTIALS_INVALID: 401, X_SIGNUP_CLOSED: 403 });
 * ```
 */
export const registerErrorStatus = (statuses: Readonly<Record<string, number>>): void => {
  for (const [code, status] of Object.entries(statuses)) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw errorStatusInvalid(code, `${String(status)} is not an HTTP status (100-599)`);
    }
    // The framework's own codes are not negotiable: an app that could map `X_UNAUTHENTICATED`
    // to 200 would be an app whose 401 contract every client already depends on, changed.
    if (ERROR_STATUS[code] !== undefined) {
      throw errorStatusInvalid(code, `the framework already maps it to ${ERROR_STATUS[code]}`);
    }
    const existing = APP_ERROR_STATUS.get(code);
    if (existing !== undefined && existing !== status) {
      throw errorStatusInvalid(code, `already registered as ${existing} by this app`);
    }
    APP_ERROR_STATUS.set(code, status);
  }
};

/** Test seam. Production registers once at boot and never unregisters. */
export const resetErrorStatus = (): void => APP_ERROR_STATUS.clear();

/** Every status the app declared, for `x errors list` and the manifest. */
export const appErrorStatus = (): Readonly<Record<string, number>> =>
  Object.fromEntries([...APP_ERROR_STATUS].sort(([a], [b]) => a.localeCompare(b)));

// Framework table first: `registerErrorStatus` already refuses those codes, so the order is
// belt-and-braces — but it is the belt that makes "the framework's statuses are fixed" true
// even if a future caller reaches the map some other way.
export const statusFor = (code: string): number =>
  ERROR_STATUS[code] ?? APP_ERROR_STATUS.get(code) ?? DEFAULT_STATUS;

/** Everything a renderer (problem+json, overlay, terminal) needs from a throwable. */
export interface ErrorFacts {
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly status: number;
  /** Present only when the process is in dev mode; never sent to a client in prod. */
  readonly stack: string | undefined;
}

const str = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Normalises any throwable into the framework's error contract. Non-Ultimate
 * throwables still get a code and a fix, because "errors are instructions" has to
 * hold for the accidental `TypeError` too.
 */
export const factsOf = (error: unknown): ErrorFacts => {
  const record = asRecord(error);
  const code = str(record, 'code') ?? 'X_INTERNAL';
  // The error's own title first: every `UltimateError` resolves one from the code registry at
  // construction, so this renders the OWNING package's title — including the codes http only
  // borrows (`X_FORBIDDEN` is policy's, `X_UNAUTHENTICATED` is auth's) and so cannot title itself.
  // Falling through to `message` here shipped the code twice: `X_FORBIDDEN: policy denied… — …`.
  const title =
    str(record, 'title') ??
    HTTP_ERROR_TITLES[code as keyof typeof HTTP_ERROR_TITLES] ??
    str(record, 'message') ??
    'unhandled server error';
  // The last fallback is the only one that touches the throwable whole, and every throwable a
  // request produces reaches it. `String()` runs the value's own `toString`, so the value that
  // took the request down took the 500 renderer with it and the server had nothing left to send.
  const cause = str(record, 'cause') ?? str(record, 'message') ?? renderCauseValue(error);
  return {
    code,
    title,
    cause,
    // `x logs tail` is in `PLANNED_COMMANDS` — it exits `X_NOT_IMPLEMENTED`. A fix line naming a
    // command that throws is axiom 4 inverted: the one instruction the reader is given fails.
    // `x errors explain` ships, and it is the command that answers "what is this code".
    fix:
      str(record, 'fix') ?? `x errors explain ${code} --json   # then fix the throwing call site`,
    docs: str(record, 'docs') ?? `https://ultimate.dev/errors/${code}`,
    status: statusFor(code),
    stack: str(record, 'stack'),
  };
};

/** RFC-9457 problem document. `code`/`cause`/`fix`/`docs` are our extensions. */
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string | undefined;
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly requestId: string | undefined;
}

export const toProblem = (
  error: unknown,
  meta: { instance?: string; requestId?: string } = {},
): ProblemDocument => {
  const facts = factsOf(error);
  return {
    type: facts.docs,
    title: facts.title,
    status: facts.status,
    detail: facts.cause,
    instance: meta.instance,
    code: facts.code,
    cause: facts.cause,
    fix: facts.fix,
    docs: facts.docs,
    requestId: meta.requestId,
  };
};

/** The exact three lines the terminal prints, reused by the overlay and `--json`. */
export const renderErrorLines = (error: unknown): string => {
  const facts = factsOf(error);
  return `${facts.code}: ${facts.title}\n  cause: ${facts.cause}\n  fix:   ${facts.fix}`;
};
