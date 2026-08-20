// The ratchet under `scripts/error-map.ts`: every framework code owned by a tier <= 4 package that
// has NO row in `packages/http/src/error-map.ts` today. The list may shrink and may never grow —
// a NEW code owned by one of those packages must be given a row, or added here on purpose.
//
// Why a pinned list and not a derivation. "Can this code reach an HTTP caller?" is not decidable
// from the source: `X_MIGRATION_DESTRUCTIVE` and `X_TENANCY_CROSS_DENIED` are the same tier, the
// same shape and one grep apart, and only a human knows the first is a CLI-time refusal and the
// second is a request a user just made. Every package's `src/index.ts` re-exports everything, so
// module-level reachability collapses to "the whole package" the moment it crosses a package
// boundary — there is no import graph that separates them either. So the classification is
// recorded, not computed, and the mechanism that makes it safe is the ratchet, exactly as
// `expectedRed` in `scripts/lib/gated-apps.ts` does for the tracked apps' gate steps.
//
// An entry here is NOT a claim that the code can never cross HTTP. It is a claim that nobody has
// decided yet, and the gate's promise is only that the undecided set never grows. Deleting an
// entry and adding the row is always the better edit.

/**
 * Pinned by owning package, because that is the unit the reader edits: a code arrives in one
 * package's `errors.ts`, and the group comment says what that package's unpinned codes have in
 * common. Regenerating this file is mechanical — `owner` is `scripts/manifest.ts`'s `ownerOf`.
 */
export const ERROR_STATUS_BACKLOG: Readonly<Record<string, readonly string[]>> = {
  // tier 0 — boot, registration and telemetry faults: raised while the process builds itself, or
  // by an image/secrets path that answers nothing. `X_CURSOR_INVALID` left on purpose: it IS a
  // request, and it has a row.
  core: [
    'X_ASYNC_CONTEXT_UNAVAILABLE',
    'X_CONFIG_INVALID',
    'X_CURSOR_SECRET_DEV',
    'X_ENVIRONMENT_INVALID',
    'X_ENV_EXAMPLE_DRIFT',
    'X_ENV_MISSING',
    'X_ERROR_CODE_DUPLICATE',
    'X_ERROR_REPORTER_DSN_INVALID',
    'X_ERROR_RETRY_INVALID',
    'X_ID_INVALID',
    'X_IMAGE_DECODE_FAILED',
    'X_IMAGE_TOO_LARGE',
    'X_INVARIANT',
    'X_METRIC_CARDINALITY',
    'X_METRIC_NAME_INVALID',
    'X_METRIC_VALUE_INVALID',
    'X_NO_CONTEXT',
    'X_OTLP_ENDPOINT_INVALID',
    'X_OTLP_PROTOCOL_UNSUPPORTED',
    'X_READINESS_CHECK_DUPLICATE',
    'X_REGISTRAR_CONFLICT',
    'X_REGISTRAR_MISSING',
    'X_ROLE_INVALID',
    'X_SECRETS_FILE_INVALID',
    'X_SECRETS_FILE_MISSING',
    'X_SECRETS_KEY_INVALID',
    'X_SECRETS_KEY_MISMATCH',
    'X_SECRETS_KEY_MISSING',
    'X_SECRETS_PLAINTEXT_INVALID',
    'X_SECRETS_TAMPERED',
    'X_SERVICE_DUPLICATE',
    'X_SERVICE_MISSING',
    'X_SHUTDOWN_TIMEOUT',
    'X_TELEMETRY_SAMPLER_ARG_INVALID',
    'X_UNREACHABLE',
  ],
  // tier 0 — schema-definition faults, raised where a schema is DECLARED. The caller-side parse
  // failure is `X_INPUT_INVALID`, which already has its row.
  schema: [
    'X_SCHEMA_DEFAULT_UNSHAREABLE',
    'X_SCHEMA_DISCRIMINANT_INVALID',
    'X_SCHEMA_UNSUPPORTED',
    'X_VALIDATION_FAILED',
  ],
  // tier 1 — cache driver and declaration faults; a cache miss is not an answer to a caller.
  cache: [
    'X_CACHE_DRIVER_UNAVAILABLE',
    'X_CACHE_JITTER_INVALID',
    'X_CACHE_PURGE_FAILED',
    'X_CACHE_TAG_UNKNOWN',
    'X_CACHE_TOO_LARGE',
    'X_CACHE_TTL_INVALID',
  ],
  // tier 1 — migration and pool faults, most of them `x db` commands or release-phase work. The
  // two a request produces (unique / foreign-key violation) are unpinned and have rows.
  db: [
    'X_BRANCH_EXISTS',
    'X_DB_LOCK_TIMEOUT',
    'X_DB_POOL_EXHAUSTED',
    'X_DB_SERIALIZATION_FAILURE',
    'X_DB_STATEMENT_TIMEOUT',
    'X_DB_UNAVAILABLE',
    'X_MIGRATE_CONCURRENT',
    'X_MIGRATION_CONFLICT',
    'X_MIGRATION_DESTRUCTIVE',
    'X_MIGRATION_IRREVERSIBLE',
    'X_MIGRATION_SNAPSHOT_MISSING',
    'X_SQL_UNSAFE',
  ],
  // tier 1 — flag declaration and evaluation faults, raised at registration or at an evaluation
  // that a handler is expected to have set up.
  flags: [
    'X_FLAG_DUPLICATE',
    'X_FLAG_EXPIRED',
    'X_FLAG_EXPIRY_INVALID',
    'X_FLAG_SUBJECT_REQUIRED',
    'X_FLAG_TARGETING_INVALID',
    'X_FLAG_UNKNOWN',
  ],
  // tier 1 — catalog faults, raised by the build and by `x i18n`. The request-time one is
  // `X_LOCALE_UNSUPPORTED`, which is unpinned.
  i18n: ['X_CATALOG_INVALID', 'X_CATALOG_MISSING_KEYS', 'X_CATALOG_UNREGISTERED'],
  // tier 1 — two classes, and only the second is arithmetic.
  //
  // `X_CURRENCY_INVALID` and `X_CURRENCY_REDEFINED` are `registerCurrency`'s refusals and nothing
  // else raises them — `packages/money/src/currency.ts:118,130,136,142` are the only four throw
  // sites in the repo. That is the same module-scope registry shape as `registerErrorStatus`,
  // `registerRoute`, `registerErrorCodes` and `registerActions`, whose own duplicate-and-invalid
  // codes are all pinned here too, so this is the answer already given six times over. Nothing
  // REFUSES a call from inside a handler, but `REGISTERED` is per PROCESS: a request-driven
  // registration lands on one replica and leaves the others answering `X_CURRENCY_UNKNOWN` for
  // every amount in that currency, so it is broken before a status could describe it. A currency
  // that arrives over the wire never reaches the function either — it reaches `assertCurrency`,
  // which is `X_CURRENCY_UNKNOWN`.
  //
  // The rest are arithmetic faults, raised on two values the app already holds. `X_CURRENCY_UNKNOWN`
  // LEFT this group rather than joining it: the line here used to read "a caller never names a
  // currency directly", and `@ultimat3/schema`'s `CURRENCY_CODE_PATTERN`, the OpenAPI `pattern`
  // emitted from it and `@ultimat3/entity`'s `char(3)` CHECK all accept any `^[A-Z]{3}$` — so a
  // caller CAN post an unregistered code, reach `money()`, and used to be told 500 for a value the
  // framework's own schema had just accepted. It has a 400 row now.
  money: [
    'X_ALLOCATION_INVALID',
    'X_CURRENCY_INVALID',
    'X_CURRENCY_MISMATCH',
    'X_CURRENCY_REDEFINED',
    'X_MONEY_NOT_INTEGER',
    'X_MONEY_SCALE_INVALID',
    'X_RATE_MISSING',
  ],
  // tier 1 — SEO metadata rules. The budget half was retired in 1.3.0 — `@ultimat3/render`'s X_BUDGET_EXCEEDED is the one a build raises.
  seo: [
    'X_LD_INVALID',
    'X_SEO_CANONICAL_MISMATCH',
    'X_SEO_DUPLICATE_META',
    'X_SEO_META_MISSING',
    'X_SEO_META_TOO_LONG',
    'X_SITEMAP_TOO_LARGE',
  ],
  // tier 1 — driver-side failures behind a `/media/*` or `/_storage` route. The caller-facing
  // storage codes all have rows already; these three are the disk's, not the caller's.
  storage: [
    'X_STORAGE_DELETE_FAILED',
    'X_STORAGE_DISK_UNKNOWN',
    'X_STORAGE_LIST_FAILED',
    'X_STORAGE_UPLOAD_FAILED',
  ],
  // tier 1 — schedule and zone parsing, raised where a `job` or a formatter is DECLARED.
  time: [
    'X_CRON_INVALID',
    'X_CRON_NOT_DESCRIBABLE',
    'X_DST_AMBIGUOUS',
    'X_DST_NONEXISTENT',
    'X_DURATION_INVALID',
    'X_INSTANT_INVALID',
    'X_LOCALE_INVALID',
    'X_SCHEDULE_INVALID',
    'X_TIMEZONE_INVALID',
  ],
  // tier 2 — limiter wiring refused at boot, a provider registered twice, and a write to the
  // identity store. Every request-facing auth code already has a row.
  auth: [
    'X_AUTH_LIMITER_NOT_SHARED',
    'X_AUTH_LIMITER_POLICY_MISMATCH',
    'X_AUTH_WRITE_FAILED',
    'X_OAUTH_PROVIDER_DUPLICATE',
  ],
  // tier 2 — dev notices (the N+1 pair, surfaced by the overlay, never thrown at a caller) and
  // repository misuse a handler's author makes, not the caller.
  entity: [
    'X_N_PLUS_ONE_QUERY',
    'X_N_PLUS_ONE_WRITE',
    'X_PATCH_EMPTY',
    'X_PRELOAD_UNKNOWN_RELATION',
    'X_REPO_CLIENT_PINNED',
    'X_WRITE_UNFILTERED',
  ],
  // tier 2 — a role declared twice at registration.
  policy: ['X_ROLE_REDEFINED'],
  // tier 3 — registration, projection and contract faults raised while actions are DEFINED, plus
  // the audit sink and the RPC client. The two idempotency codes a caller can trip are unpinned.
  action: [
    'X_ACTION_DEPRECATION_INVALID',
    'X_ACTION_DUPLICATE',
    'X_ACTION_FOREIGN',
    'X_ACTION_PATH_DUPLICATE',
    'X_ACTION_POLICY_MISSING',
    'X_ACTION_UNREGISTERED',
    'X_AUDIT_SINK_FAILED',
    'X_AUDIT_SINK_MISSING',
    'X_CONTRACT_DRIFT',
    'X_IDEMPOTENCY_NOT_SHARED',
    'X_OUTPUT_INVALID',
    'X_RPC_FAILED',
  ],
  // tier 3 — the worker's own vocabulary. A job runs with no socket attached; `ROLE=worker` opens
  // no HTTP port at all, so none of these is ever a response.
  jobs: [
    'X_BACKFILL_APPLIED',
    'X_BACKFILL_ENVIRONMENT',
    'X_BACKFILL_MIGRATION_PENDING',
    'X_BACKFILL_PENDING',
    'X_BACKFILL_RUNNING',
    'X_BACKFILL_STALLED',
    'X_BACKFILL_UNKNOWN',
    'X_DRIVER_UNAVAILABLE',
    'X_IDEMPOTENCY_REQUIRED',
    'X_JOB_CONCURRENCY_UNENFORCEABLE',
    'X_JOB_DUPLICATE',
    'X_JOB_LEASE_LOST',
    'X_JOB_MAX_ATTEMPTS',
    'X_JOB_NOT_CANCELLABLE',
    'X_JOB_SLOT_LOST',
    'X_JOB_TENANT_REQUIRED',
    'X_JOB_TIMEOUT',
    'X_OUTBOX_NO_TX',
    'X_STEP_DUPLICATE',
  ],
  // tier 3 — query declaration faults, raised where a query is DEFINED. `X_QUERY_NOT_PAGEABLE` is
  // unpinned: a caller asking for page 2 of an unpageable query is a caller's mistake.
  query: [
    'X_CURSOR_VALUE_UNSUPPORTED',
    'X_MATCHER_UNSUPPORTED',
    'X_QUERY_CACHE_TTL_INVALID',
    'X_QUERY_DEPRECATION_INVALID',
    'X_QUERY_DUPLICATE',
    'X_QUERY_FOREIGN',
    'X_QUERY_INPUT_UNENCODABLE',
    'X_QUERY_POLICY_MISSING',
    'X_QUERY_UNREGISTERED',
  ],
  // tier 3 — the sync node's own vocabulary. These are answered on a WebSocket frame, which
  // carries a `kind` and not a status; the HTTP upgrade is the only crossing, and it has none of
  // these. Worth revisiting the day a frame kind is projected onto a status.
  realtime: [
    'X_CURSOR_STALE',
    'X_FRAME_RATE_LIMIT',
    'X_LIVE_CLIENT_MISSING',
    'X_LIVE_QUERY_UNKNOWN',
    'X_LIVE_REPLICA_IDENTITY',
    'X_LIVE_ROW_UNIDENTIFIED',
    'X_PROTOCOL_VERSION',
    'X_QUERY_NOT_SUBSCRIBABLE',
    'X_REBASE_CONFLICT',
    'X_REPLICATION_FAILED',
    'X_REPLICATION_PROTOCOL',
    'X_REPLICATOR_SLOT_HELD',
    'X_SOCKET_AUTH_UNAVAILABLE',
    'X_SOCKET_UNAUTHENTICATED',
    'X_SUBSCRIPTION_ID_TAKEN',
    'X_SUBSCRIPTION_LIMIT',
    'X_TOPIC_FORBIDDEN',
    'X_TRANSPORT_PROTOCOL',
    'X_TRANSPORT_UNAVAILABLE',
  ],
  // tier 4 — model-call and eval faults. An `llm()` IS an action and several of these are
  // caller-visible through it; the statuses are a judgement nobody has made yet, and this is the
  // largest single group that should shrink.
  ai: [
    'X_AGENT_MAX_TURNS',
    'X_AGENT_TOOL_UNEXPOSED',
    'X_AI_BUDGET_EXCEEDED',
    'X_AI_EMBEDDER_INVALID',
    'X_AI_GATEWAY_MISSING',
    'X_AI_KEY_MISSING',
    'X_AI_MODEL_UNKNOWN',
    'X_AI_PROMPT_SECRET',
    'X_AI_PROMPT_VERSION',
    'X_AI_PROVIDER_UNAVAILABLE',
    'X_AI_REQUEST_INVALID',
    'X_EVAL_BASELINE_INVALID',
    'X_EVAL_BASELINE_MISSING',
    'X_EVAL_MISSING',
    'X_EVAL_RECORDING',
    'X_EVAL_THRESHOLD',
    'X_LLM_OUTPUT_INVALID',
    'X_LLM_REFUSED',
    'X_LLM_STREAM_INVALID',
    'X_LLM_TRUNCATED',
    'X_VECTOR_DIM_MISMATCH',
    'X_VECTOR_SCOPE_WIDENED',
  ],
  // tier 4 — mail is sent from a job or a handler and never answered to one; a send failure is
  // the transport's, not the caller's.
  mail: [
    'X_MAIL_DRIVER_UNAVAILABLE',
    'X_MAIL_DUPLICATE',
    'X_MAIL_ADDRESS_INVALID',
    'X_MAIL_HEADER_INVALID',
    'X_MAIL_LOCALE_MISSING',
    'X_MAIL_SEND_FAILED',
    'X_MAIL_TEMPLATE_UNKNOWN',
    'X_MAIL_TEXT_MISSING',
  ],
  // tier 4 — build-time only: the manifest emitter and the `AGENTS.md` rules, all on `x verify`.
  manifest: [
    'X_AGENTS_MD_MISSING',
    'X_AGENTS_MD_TOO_LARGE',
    'X_MANIFEST_BREAKING',
    'X_MANIFEST_DRIFT',
  ],
  // tier 4 — MCP answers over its own JSON-RPC envelope, which carries an error object and not a
  // status. Revisit if the MCP host is ever mounted on an HTTP route inside the pipeline.
  mcp: [
    'X_MCP_ARGS_INVALID',
    'X_MCP_NOT_BRANCH_DB',
    'X_MCP_PROTOCOL',
    'X_MCP_QUERY_REJECTED',
    'X_MCP_RESOURCE_DUPLICATE',
    'X_MCP_SCOPE_CONFLICT',
    'X_MCP_SCOPE_DENIED',
    'X_MCP_SCOPE_UNKNOWN',
    'X_MCP_TOOL_DUPLICATE',
    'X_MCP_TOOL_UNDECLARED',
    'X_MCP_TOOL_UNKNOWN',
    'X_MCP_TOOL_UNSAFE',
  ],
  // tier 4 — the service worker and the PWA manifest: build-time rules plus faults raised in the
  // BROWSER, where there is no response to give a status to.
  pwa: [
    'X_BUILD_ID_MISSING',
    'X_PWA_ICON_MISSING',
    'X_PWA_MANIFEST_INVALID',
    'X_PWA_NO_OFFLINE_FALLBACK',
    'X_PWA_STRATEGY_EXHAUSTED',
    'X_PWA_SYNC_FLUSH_FAILED',
    'X_PWA_SYNC_INCOMPLETE',
    'X_SW_SCOPE_INVALID',
  ],
  // tier 4 — route-declaration and prerender rules, enforced at build and at `registerRoute`.
  // `X_PRERENDER_FAILED` and `X_ROUTE_LOAD_FAILED` are the ones to look at first if this group
  // shrinks: a lazily loaded route can fail while a request is waiting on it.
  render: [
    'X_BUDGET_EXCEEDED',
    'X_ISLAND_INVALID',
    'X_ISLAND_NOT_HYDRATED',
    'X_ISLAND_PROPS_INVALID',
    'X_PRERENDER_FAILED',
    'X_ROUTE_DUPLICATE',
    'X_ROUTE_FILE_INVALID',
    'X_ROUTE_LOAD_FAILED',
    'X_ROUTE_LOAD_INVALID',
    'X_ROUTE_META_MISSING',
    'X_ROUTE_MODE_INVALID',
    'X_ROUTE_OFFLINE_MISSING',
    'X_ROUTE_UNNORMALIZED',
    'X_STYLES_GLOBAL_MISSING',
    'X_SURFACE_BOUNDARY',
  ],
  // tier 4 as of 2026-08-19 — `ui` moved 5 -> 4 to delete the `admin -> ui` sideways exception,
  // which brought its codes into this rule's scope for the first time. Same class as `render`
  // above: author errors raised while a component is DECLARED or rendered, not answers to a
  // caller. A bad design token, an unknown theme and a missing Solid runtime are all wrong-code
  // faults an author fixes once, and none of them is a status a client should act on.
  //
  // `X_UI_INVALID_VALUE` is the one to look at first if this group shrinks: `@ultimat3/admin`
  // renders these components INSIDE a request, so a column value a widget cannot render — a
  // float where `Money` belongs, a timestamptz with no zone — raises it with a request waiting.
  // It answers 500 today, which is honest for a server-side data fault; it is pinned rather than
  // mapped because a row here would be asserting a status nobody has chosen on purpose.
  ui: ['X_THEME_INVALID', 'X_TOKEN_UNKNOWN', 'X_UI_INVALID_VALUE', 'X_UI_RUNTIME_MISSING'],
};

/** Every pinned code, flat. The owner grouping is for the reader; the rule is per code. */
export const backlogCodes = (
  backlog: Readonly<Record<string, readonly string[]>> = ERROR_STATUS_BACKLOG,
): ReadonlySet<string> => new Set(Object.values(backlog).flat());

/** Which group an entry sits in, so a `fix:` can name the exact line to delete. */
export const backlogGroupOf = (
  code: string,
  backlog: Readonly<Record<string, readonly string[]>> = ERROR_STATUS_BACKLOG,
): string | undefined => Object.entries(backlog).find(([, codes]) => codes.includes(code))?.[0];
