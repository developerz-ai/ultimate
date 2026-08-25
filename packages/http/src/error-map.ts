// The one place a framework error code becomes an HTTP status. A table, not a
// switch chain: adding a code elsewhere in the framework means adding a row here,
// and a missing row is a loud 500 rather than a silently wrong 200.
// Rendering a throwable for a reader is `error-facts.ts`; this file answers only the status.
import { errorStatusInvalid } from './errors';

/**
 * code -> status. Codes owned by other packages are listed here on purpose: HTTP
 * is the only layer that knows what a status means, so no other package should
 * ever hardcode one.
 */
export const ERROR_STATUS = {
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
  // A `hive()` whose `split()` returned no members. The caller cannot fix it by sending
  // different input — the guard belongs in the app, either by returning at least one member
  // or by skipping the hive when the source is empty — so it is the server's bug, not theirs.
  X_HIVE_EMPTY: 500,
  // Thrown while `app.config.ts` resolves, so no request is ever answered with it — the row exists
  // because a code with no status is a 500 anyway and this table is the closed one.
  X_CORS_CONFIG_INVALID: 500,
  X_CSP_DIRECTIVE_INVALID: 500,
  // Thrown while the server is being constructed, so no request is ever answered with it either.
  // The row exists because this table is the closed one: a code missing from it is a 500 anyway,
  // and a code the framework owns must never fall through to the app's table.
  X_RATE_LIMIT_NOT_SHARED: 500,
  // Same construction-time class as the row above: a route and the config declare one bucket
  // differently, and the process refuses to start rather than pick.
  X_RATE_LIMIT_BUCKET_CONFLICT: 500,
  // Construction time as well: the limiter installed cannot enforce a bucket a route declares.
  X_RATE_LIMIT_BUCKET_UNBOUND: 500,
  // `defineHttpConfig` time, all three: a declaration the deployment owes and did not make, or
  // made against a bucket nothing declares.
  X_RATE_LIMIT_SCOPE_UNSET: 500,
  X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN: 500,
  X_TRUST_PROXY_UNSET: 500,
  // Raised by `toBucket` while a route or an action is being projected, never on the request.
  X_RATE_LIMIT_INVALID: 500,
  // The shared store did not answer, so nothing decided. An operator's fault, never the caller's.
  X_RATE_LIMIT_STORE_UNAVAILABLE: 500,
  // The two the `admit` stage answers with, and the only 503s the pipeline produces. Both carry
  // `retry-after`: a shed request that does not say when to come back is a request that comes
  // back immediately, which is the load it was shed to avoid.
  X_DRAINING: 503,
  X_OVERLOADED: 503,
  // Core's flight gate refusing past `maxQueued` is the same answer one tier down: it carries
  // `retryAfterSeconds` in `meta`, which `stages.ts` renders onto `Retry-After`, so a caller that
  // already handles a shed request needs no second branch for a refused one.
  X_FLIGHT_GATE_OVERLOADED: 503,
  // 403 and never 401: the caller IS authenticated — that is what makes the forged write work —
  // so a 401 would send a signed-in user to a sign-in page they are already past.
  X_CSRF_BLOCKED: 403,
  // 401 for both, and never 400: an inbound webhook is well formed and carries a CREDENTIAL — a
  // timestamped hmac over its own bytes — so what failed is authentication, not the request. Never
  // 403 either, which means an authenticated caller was refused, and there is no authenticated
  // caller here. Two codes rather than one because the repairs differ and a sender's dashboard
  // shows the status: `INVALID` is the wrong secret or a rewritten body, `STALE` is a skewed clock
  // or a delivery being replayed off a capture. Neither triggers `signInRedirect`, which keys on
  // `X_UNAUTHENTICATED` alone — a webhook sender is not a browser and has no session to go get.
  X_WEBHOOK_SIGNATURE_INVALID: 401,
  X_WEBHOOK_SIGNATURE_STALE: 401,
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
  // Same shape as the line above and 500 for the same reason: the store holds a record this
  // build cannot turn into a result. Deliberately NOT 503 — a rolling deploy is the usual
  // cause, so a retry may well reach a newer pod and succeed, but this code carries no
  // `retry-after` and the two 503s above are the only ones that do. Telling a caller to come
  // back without saying when is the load-shedding mistake, one layer up.
  X_IDEMPOTENCY_STATUS_UNKNOWN: 500,
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
  // 422 for the same reason as the row above, and deliberately not 500: `enrolTotp` throws it for a
  // secret the CALLER supplied — an import from another MFA system, or a value off a form — and
  // what failed is that value's content, not the server. `verifyTotp` never throws it (an
  // unreadable stored secret is a non-verdict there, the rule `verifyAgainst` follows for a hash
  // Bun cannot read), so a login checking a broken row cannot reach this status at all.
  X_MFA_SECRET_INVALID: 422,
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
  // The three aggregate refusals, all 500 and all deliberately NOT a 4xx, for the reason
  // `X_QUERY_NOT_PAGEABLE` below is one: nothing the caller sends changes the answer, and the fix
  // is an edit to the read itself. They earn ROWS rather than a pin in `scripts/error-map-backlog.ts`
  // because each carries an instruction the app's author needs and an unmapped 5xx is blanked —
  // `toProblem` replaces an undeclared code's cause with `INTERNAL_CAUSE`, so pinning them would
  // answer "the server failed while handling this request" for a fault whose own `fix:` names the
  // exact call to write instead. A row costs no extra page: `stages.ts` reports every `status >= 500`
  // either way.
  //
  // Reached with a request waiting, all three, which is why they are not in the backlog's entity
  // group ("misuse a handler's author makes") — the mixed-currency and the ±2^53 refusals are
  // decided by the ROWS, so a read that answered for two years starts failing on the day the data
  // crosses the line, and `approximateCount()` on a chain whose predicates came from the caller's
  // own optional filters is one query string away.
  X_AGGREGATE_UNSUPPORTED: 500,
  X_AGGREGATE_MIXED_CURRENCY: 500,
  X_APPROXIMATE_COUNT_FILTERED: 500,
  // The two search refusals, 500 for the reason the three above are: nothing the caller sends
  // changes either answer. An entity with no searchable column needs a `searchable()` on one, and
  // a driver that cannot answer a full-text match needs the Postgres one — both are edits to the
  // app, and both carry a `fix:` that an unmapped 5xx would blank (`toProblem` replaces an
  // undeclared code's cause with `INTERNAL_CAUSE`).
  X_SEARCH_UNDECLARED: 500,
  X_SEARCH_IN_MEMORY: 500,
  // The three state-machine refusals, and they are deliberately THREE statuses rather than one:
  // the machine says the transition does not exist, the row says it is somewhere else, or the
  // column says there is no machine at all — three different readers and three different repairs.
  //
  // 422 and not 400: the request is well formed and its schema passed. The transition the caller
  // named is not one this machine has, which is the same shape as `X_INVARIANT_VIOLATED` above and
  // takes its status. Refused before any statement opens a connection, so nothing was written.
  X_STATE_TRANSITION_ILLEGAL: 422,
  // 409, the lost update caught. The row moved between the read the caller decided on and the
  // write it asked for — nothing is wrong with either, and the repair is re-read and retry, which
  // is precisely what a 409 tells a client to do. A 422 would say "your request is unusable",
  // which is false: the identical request succeeds a moment later.
  X_STATE_CONFLICT: 409,
  // 500, the same shelf as `X_SEARCH_UNDECLARED`: a column with no machine is a declaration the
  // app has not written, and no request changes that.
  X_STATE_UNDECLARED: 500,
  // @ultimat3/db — the constraints a request trips, both 409. db's own `fix:` for the unique
  // violation says "answer 409, which is what a raced signup is", and `X_ENTITY_DUPLICATE` — the
  // same event one layer up — is 409 above; a foreign key rides with it because both halves of it
  // are a conflict with the state that is there (the parent is missing, or the child still points
  // at it), which 422 describes only for the insert.
  X_DB_UNIQUE_VIOLATION: 409,
  X_DB_FOREIGN_KEY_VIOLATION: 409,
  // @ultimat3/jobs — the ONE jobs code with a row here, and the reason the rest are pinned in
  // `scripts/error-map-backlog.ts` does not cover it. That pin says "a job runs with no socket
  // attached; `ROLE=worker` opens no HTTP port at all" — true of `X_JOB_TIMEOUT` and every other
  // worker-runtime code, and NOT true of a decode failure: `toJobRecord` runs wherever a row is
  // READ, which includes the admin dashboard's job panel and `x jobs show` served over HTTP.
  // 500, and it should page: a queue holding rows this build cannot read is an operator's
  // problem, and nothing the caller sent is wrong.
  X_JOB_ROW_STATUS_UNKNOWN: 500,
  // Thrown by `registerJobs()` while the app's modules load, so no request is ever answered with
  // it either — the row exists for the reason `X_CORS_CONFIG_INVALID`'s does: this table is the
  // closed one, and a code with no row is a 500 anyway.
  X_ACTION_JOB_UNBRIDGED: 500,
  // Every `X_WEBHOOK_*` below is OUTBOUND and is thrown inside a worker: `ROLE=worker` opens no
  // HTTP port, so none of them ever answers a request. The rows exist for the reason
  // `X_ACTION_JOB_UNBRIDGED`'s does — this table is the closed one, and a code with no row is a
  // 500 anyway. The INBOUND pair (`X_WEBHOOK_SIGNATURE_*`, 401) is @ultimat3/http's and sits with
  // the rest of this package's codes above; these are the ones a delivery ends on.
  X_WEBHOOK_ENDPOINT_UNKNOWN: 500,
  X_WEBHOOK_ENDPOINT_INVALID: 500,
  X_WEBHOOK_ENDPOINT_DISABLED: 500,
  X_WEBHOOK_EVENT_UNKNOWN: 500,
  X_WEBHOOK_EVENT_INVALID: 500,
  X_WEBHOOK_DELIVERY_FAILED: 500,
  X_WEBHOOK_DELIVERY_THROTTLED: 500,
  X_WEBHOOK_DELIVERY_REJECTED: 500,
  // Same class again: an export pass runs in a worker, and both codes refuse the DECLARATION —
  // a `row()` that answers columns nobody declared, and a page too big to hold. Neither is
  // anything a caller sent.
  X_EXPORT_ROW_INVALID: 500,
  X_EXPORT_PART_TOO_LARGE: 500,
  // @ultimat3/notify — five 500s and one 502, and the split is who failed.
  //
  // The five are the app's own declaration: a notifier with no channels, one channel named twice,
  // a digest window on a bulk channel, a store nothing installed, and a fan-out past the per-run
  // ceiling. Every `fix:` on those five names a code edit or a boot call, so nothing a caller
  // sends changes any of them — `X_NOTIFY_FANOUT_TOO_WIDE` is the only one a request can even
  // INFLUENCE (an action that notifies a whole org), and the repair is still `bulkChannel()` or a
  // paged `backfill()`, never the request.
  X_NOTIFY_CHANNELS_EMPTY: 500,
  X_NOTIFY_CHANNEL_DUPLICATE: 500,
  X_NOTIFY_FANOUT_TOO_WIDE: 500,
  X_NOTIFY_STORE_MISSING: 500,
  X_NOTIFY_DIGEST_UNSUPPORTED: 500,
  // 502, and it is the one row on this table that answers for somebody else's server. This code
  // WRAPS a provider rejection — `NotifyDeliveryFailedError` takes the caught value and renders it
  // — so the thing that failed is the channel's upstream, not this process. It is thrown inside a
  // job step today (`x jobs show <notifier> --json` is its own `fix:`), so nothing reaches a
  // request and the number is unobservable either way; the row is chosen for the day that stops
  // being true, and the asymmetry decides it. A wrong 502 costs nothing. A wrong 500 pages the
  // on-call for an email provider's outage, because `stages.ts` reports every `status >= 500` to
  // the error monitor — which is the failure this whole table exists to stop.
  X_NOTIFY_DELIVERY_FAILED: 502,
  // @ultimat3/policy
  X_POLICY_MISSING: 500,
  // A declaration fault raised at module evaluation, the same shelf as the line above. The row is
  // not a claim it reaches a request — an unmapped code already answers 500 — it is the answer
  // being REVIEWED instead of accidental, which is why this table is closed.
  X_POLICY_CLAUSE_EMPTY: 500,
  X_PERMISSION_UNKNOWN: 500,
  // 500, and the page IS the point — deliberately not a 4xx to keep this table quiet.
  // `enforce()` was handed a surface no adapter answers to, which reaches a request only through a
  // config-driven route table, a surface name off the wire or a JS host; none of those is a value
  // the caller can correct, and a 400 would tell them to fix a request that is not the problem.
  // It is the third authz-dispatch fault beside the two rows above and takes their status for the
  // same reason: the declaration is wrong, not the call.
  X_POLICY_SURFACE_UNKNOWN: 500,
  // @ultimat3/query — the read declares no id, so no cursor can name a position in it. The one
  // paging failure that is NOT the caller's: the fix is an edit to the read's own select, nothing
  // the client sends changes the answer, and the report to the on-call monitor is the point.
  X_QUERY_NOT_PAGEABLE: 500,
  // @ultimat3/i18n — a well-formed tag outside the set this app ships, asserted on a value the
  // caller supplied (`assertSupportedLocale`). 400 rather than 406: the http `locale` stage
  // negotiates `Accept-Language` and never throws, so the tag that reaches here came from a path,
  // query or body the caller wrote — the same place `X_IMAGE_QUERY_INVALID` comes from.
  X_LOCALE_UNSUPPORTED: 400,
  // @ultimat3/money — a well-formed code this process carries no row for. The currency table is
  // OPEN (`registerCurrency`), and every surface between the wire and the throw accepts any
  // `^[A-Z]{3}$`: `@ultimat3/schema`'s `CURRENCY_CODE_PATTERN`, the OpenAPI `pattern` emitted from
  // it, and `@ultimat3/entity`'s `char(3)` CHECK. So `{ minor: 100, currency: 'ZWL' }` parses,
  // reaches `money()` -> `assertCurrency`, and with no row answered 500 — reporting a value the
  // framework's own schema had just accepted to the error monitor. 400 rather than 422, beside
  // `X_LOCALE_UNSUPPORTED`: the same shape of mistake, a well-formed value naming something
  // outside the set this process carries, and money's `fix:` already instructs the caller.
  X_CURRENCY_UNKNOWN: 400,
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
  // 500, not 403, and the distinction is the whole reason this code exists rather than
  // reusing X_STORAGE_URL_INVALID: nothing is wrong with the caller's URL. The disk was
  // built with no way to check a signature, which is the operator's misconfiguration and
  // not an attacker — reporting it as 403 sends the on-call hunting somebody who is not there.
  X_STORAGE_URL_UNVERIFIABLE: 500,
  // 409, not the 500 it fell through to: the object exists and the request is well formed — the
  // STATE is wrong. A validated upload lands under the quarantine segment and `promoteAttachment`
  // refuses it until the app's own scanner calls `releaseQuarantine`, which is a thing the caller
  // can do. A 500 would have read as "the server broke" for a workflow working exactly as built.
  X_STORAGE_QUARANTINED: 409,
  // 404, deliberately NOT 403: the org check fires before anything is read, so answering
  // "forbidden" would confirm that a key exists to the one caller who must not learn it.
  X_STORAGE_ORG_MISMATCH: 404,
  // @ultimat3/ui — a form control whose `name` is not a usable field path. The owning slice argued
  // for NO ROW, on the grounds that this is a render-time developer error that can never reach
  // HTTP, and the argument is right about the code and wrong about the table.
  //
  // `scripts/error-map-backlog.ts` is the only "no row" this table has, and its own header says
  // what an entry there means: "NOT a claim that the code can never cross HTTP … a claim that
  // nobody has decided yet", with the ratchet promising only that the undecided set never grows.
  // This code HAS been decided, so a pin would record the opposite of what is known and grow the
  // one list that may not grow.
  //
  // So it takes the answer every other decided-and-unreachable code takes — `X_CORS_CONFIG_INVALID`,
  // `X_ACTION_JOB_UNBRIDGED`, `X_RATE_LIMIT_NOT_SHARED`. The row is NOT a claim that it reaches a
  // request. A code with no row already answers 500 (`DEFAULT_STATUS`); the row changes nothing at
  // runtime and makes that answer a reviewed one instead of an accident, which is the whole reason
  // this table is closed.
  X_UI_FORM_PATH_INVALID: 500,
  // @ultimat3/mail
  // The deployment configured no transport. It reaches a caller only through an inline
  // `send(…, { sync: true })` inside a request; the queued path dead-letters instead. A server-side
  // configuration fault either way, so 500 and never a 4xx — nothing the caller sent is wrong, and
  // this is exactly the condition somebody should be paged for.
  X_MAIL_CREDENTIAL_MISSING: 500,
  // @ultimat3/mcp — the one MCP code that is answered on a REQUEST rather than inside a JSON-RPC
  // envelope, which is what the rest of that package's backlog group says about the others: the
  // transport refused before dispatch, so there is no call to answer. 429 because
  // `mcpHttpRoute` already builds that response by hand (`transport-http.ts`'s `throttled`), with
  // `retry-after` beside it. The row is what keeps the two surfaces from disagreeing the day the
  // MCP host is mounted inside this pipeline — a code that renders 429 on one and 500 on the other
  // is exactly the split this table exists to prevent.
  X_MCP_RATE_LIMITED: 429,
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
  // The twin of `X_ABORTED`, and it answers the same because the outcome is the same: the caller
  // went away there, the caller's generation moved on here, and in both cases nobody will act on
  // the answer. Deliberately not 409 — that spelling asks the client to reconcile and try again,
  // and a fenced answer has nothing to reconcile against.
  X_SUPERSEDED: 499,
  X_INTERNAL: 500,
  // The keys are LITERAL — deliberately not `Readonly<Record<string, number>>`, which is what the
  // annotation used to say. This table is the closed one, so `ERROR_STATUS.X_QUERY_NOT_PAGABLE`
  // has to be a compile error rather than an `undefined` a test then asserts `toBeNumber()` on.
  // Read it by a code the framework did not mint through `statusFor`, never by index.
} satisfies Readonly<Record<string, number>>;

export const DEFAULT_STATUS = 500;

/**
 * The framework's row for a code, or `undefined` — through `Object.hasOwn`, never `[code]`.
 *
 * `code` is a STRING read off a throwable this package did not build, and `ERROR_STATUS` is an
 * object literal, so it holds every name on `Object.prototype`: an app throwing
 * `{ code: 'toString' }` read a FUNCTION out of this table. `statusFor` handed it to
 * `new Response(body, { status })` — a `RangeError` raised inside `recoverWith`'s fallback, the
 * one frame with nothing above it, so `Pipeline.handle` REJECTED against its own contract.
 * `scripts/error-map.ts` reads the same table this way already.
 */
const BY_CODE: Readonly<Record<string, number>> = ERROR_STATUS;

const frameworkStatus = (code: string): number | undefined =>
  Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : undefined;

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
    // Through `frameworkStatus`, so this refusal cannot answer for a code the framework does not
    // own: `registerErrorStatus({ toString: 401 })` was rejected with a cause reading `the
    // framework already maps it to function toString() { [native code] }`.
    const framework = frameworkStatus(code);
    if (framework !== undefined) {
      throw errorStatusInvalid(code, `the framework already maps it to ${framework}`);
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

/**
 * The status SOMEBODY declared for a code — the framework or the app — or `undefined` when
 * nobody did. The two questions `statusFor` used to answer at once are separate on purpose:
 * "what do we answer" is always a number, and "did anyone classify this" is what `error-facts.ts`
 * reads to decide whether a 5xx may carry the throwable's own words back to the caller.
 *
 * Framework table first: `registerErrorStatus` already refuses those codes, so the order is
 * belt-and-braces — but it is the belt that makes "the framework's statuses are fixed" true
 * even if a future caller reaches the map some other way.
 * `APP_ERROR_STATUS` is a `Map`, which is why its half never had `frameworkStatus`'s defect —
 * prefer one for anything keyed by a value a caller chose.
 */
export const declaredStatusFor = (code: string): number | undefined =>
  frameworkStatus(code) ?? APP_ERROR_STATUS.get(code);

export const statusFor = (code: string): number => declaredStatusFor(code) ?? DEFAULT_STATUS;
