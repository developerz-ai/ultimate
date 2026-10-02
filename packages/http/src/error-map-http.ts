// One slice of the status table `error-map.ts` composes: `@ultimat3/http`'s own codes.
// A row here is a code owned by `@ultimat3/http`; `bun run new-error-code` appends to the slice its
// `--package` belongs to, so no one file grows with every code the framework adds.

export const HTTP_ERROR_STATUS = {
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
  X_PROBLEM_META_INVALID: 500,
  // A `hive()` whose `split()` returned no members. The caller cannot fix it by sending
  // different input — the guard belongs in the app, either by returning at least one member
  // or by skipping the hive when the source is empty — so it is the server's bug, not theirs.
  X_HIVE_EMPTY: 500,
  // Thrown while `app.config.ts` resolves, so no request is ever answered with it — the row exists
  // because a code with no status is a 500 anyway and this table is the closed one.
  X_CORS_CONFIG_INVALID: 500,
  // Core's code, borrowed by `defineHttpConfig` for a numeric knob that is not a count. Same
  // construction-time shelf as the row above, and it needs a row for the same reason: this table
  // is closed over every code the package can throw, borrowed ones included.
  X_CONFIG_INVALID: 500,
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
  // Boot refusals of the app's HTTP declaration (a bearer mount, an action's pinned path or the
  // app's path style or a path derived before it, the openapi block, the MCP oauth block or an
  // idempotent tool shadowing its key argument, a page's `post` or `navigation`) — never a request's
  // answer; 500 if one ever escaped into a response (`x dev` re-evaluating an edited route module):
  // the deployment is wrong, the caller is not.
  X_BEARER_MOUNT_INVALID: 500,
  X_ACTION_HTTP_PATH_INVALID: 500,
  X_ACTION_PATH_STYLE_INVALID: 500,
  X_ACTION_PATH_DERIVED_EARLY: 500,
  X_OPENAPI_CONFIG_INVALID: 500,
  X_MCP_OAUTH_INVALID: 500,
  X_MCP_PATH_DUPLICATE: 500,
  X_MCP_IDEMPOTENCY_KEY_SHADOWED: 500,
  X_ROUTE_POST_INVALID: 500,
  X_ROUTE_NAVIGATION_INVALID: 500,
} satisfies Readonly<Record<string, number>>;
