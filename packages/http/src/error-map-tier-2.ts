// One slice of the status table `error-map.ts` composes: tier 2 but `http` itself — `entity`, `policy`, `auth`.
// A row here is a code owned by `entity`, `policy` or `auth`; `bun run new-error-code` appends to the slice its
// `--package` belongs to, so no one file grows with every code the framework adds.

export const TIER_2_ERROR_STATUS = {
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
  // Both are the server's verdict on a statement the app wrote, which is the app's fault and not
  // the caller's: a request cannot repair a missing migration or a wrong column list.
  X_DB_SCHEMA_STALE: 500,
  X_DB_STATEMENT_FAILED: 500,
  // Logged at boot, never thrown into a request; the row exists so the table stays closed.
  X_MCP_APP_UNMOUNTED: 500,
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
  // A sealed column named where the database would compare it, or in a view. Both are the app's
  // own declaration or call, never the caller's input — the same shelf as the two above.
  X_ENTITY_SEALED_PREDICATE: 500,
  X_ENTITY_SEALED_IN_VIEW: 500,
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
  // @ultimat3/auth — a stored totp secret is not sealed, so it is never read as one
  X_MFA_SECRET_UNSEALED: 500,
} satisfies Readonly<Record<string, number>>;
