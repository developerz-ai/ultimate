// `UNDECIDED`, the shrink-only half of the status-table pins: framework codes nobody has judged
// for whether they can reach an HTTP caller. Split out of `scripts/error-map-backlog.ts`, which
// re-exports it and keeps `OFF_SOCKET`, the list `new-error-code --off-socket` writes. Nothing
// writes here: an entry leaves for a status row or `OFF_SOCKET`, and `error-map-backlog.test.ts`
// holds the count and every code against the base.

/** This file, for a `fix:` that names where an `UNDECIDED` entry is deleted. */
export const UNDECIDED_FILE = 'scripts/lib/error-map-undecided.ts';

type Pins = Readonly<Record<string, readonly string[]>>;

/**
 * Undecided, shrink-only. Pinned by owning package, because that is the unit the reader edits; the
 * group comment says what that package's unjudged codes have in common. `owner` is
 * `scripts/manifest.ts`'s `ownerOf`.
 */
export const UNDECIDED: Pins = {
  // tier 0 — boot, registration and telemetry faults: raised while the process builds itself, or
  // by an image/secrets path that answers nothing. `X_CURSOR_INVALID` left on purpose: it IS a
  // request, and it has a row.
  core: [
    'X_ASYNC_CONTEXT_UNAVAILABLE',
    'X_CURSOR_SECRET_DEV',
    'X_ENVIRONMENT_INVALID',
    'X_ENV_MISSING',
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
    'X_OTLP_HEADERS_INVALID',
    'X_OTLP_PROTOCOL_UNSUPPORTED',
    'X_REGISTRAR_MISSING',
    'X_ROLE_INVALID',
    'X_SECRETS_FILE_INVALID',
    'X_SECRETS_FILE_MISSING',
    'X_SECRETS_KEY_INVALID',
    'X_SECRETS_KEY_MISMATCH',
    'X_SECRETS_KEY_MISSING',
    'X_SECRETS_PLAINTEXT_INVALID',
    'X_SECRETS_TAMPERED',
    'X_SERVICE_MISSING',
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
    'X_SCHEMA_DEFAULT_INVALID',
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
  // tier 1 — pool and statement faults a request can meet; the `x db` half is OFF_SOCKET. The
  // two a request produces by its input (unique / foreign-key violation) have rows.
  db: [
    'X_DB_LOCK_TIMEOUT',
    'X_DB_POOL_EXHAUSTED',
    'X_DB_SERIALIZATION_FAILURE',
    'X_DB_STATEMENT_TIMEOUT',
    'X_DB_UNAVAILABLE',
    'X_SQL_UNSAFE',
  ],
  // tier 1 — flag evaluation faults, raised at an evaluation a handler is expected to have set up.
  flags: [
    'X_FLAG_EXPIRED',
    'X_FLAG_EXPIRY_INVALID',
    'X_FLAG_SUBJECT_REQUIRED',
    'X_FLAG_TARGETING_INVALID',
    'X_FLAG_UNKNOWN',
  ],
  // tier 1 — arithmetic faults, raised on two values the app already holds. `X_CURRENCY_UNKNOWN`
  // LEFT this group rather than joining it: the line here used to read "a caller never names a
  // currency directly", and `@ultimat3/schema`'s `CURRENCY_CODE_PATTERN`, the OpenAPI `pattern`
  // emitted from it and `@ultimat3/entity`'s `char(3)` CHECK all accept any `^[A-Z]{3}$` — so a
  // caller CAN post an unregistered code, reach `money()`, and used to be told 500 for a value the
  // framework's own schema had just accepted. It has a 400 row now.
  money: [
    'X_ALLOCATION_INVALID',
    'X_CURRENCY_MISMATCH',
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
    'X_SCHEDULE_INVALID',
    'X_TIMEZONE_INVALID',
  ],
  // tier 2 — a write to the identity store. Every request-facing auth code already has a row.
  auth: ['X_AUTH_WRITE_FAILED'],
  // tier 2 — repository misuse a handler's author makes, not the caller.
  entity: [
    'X_PATCH_EMPTY',
    'X_PRELOAD_UNKNOWN_RELATION',
    'X_REPO_CLIENT_PINNED',
    'X_WRITE_UNFILTERED',
  ],
  // tier 3 — projection and contract faults raised while actions are DEFINED, plus the audit
  // sink and the RPC client. The two idempotency codes a caller can trip are unpinned.
  action: [
    'X_ACTION_DEPRECATION_INVALID',
    'X_ACTION_FOREIGN',
    'X_ACTION_POLICY_MISSING',
    'X_ACTION_UNREGISTERED',
    'X_AUDIT_SINK_FAILED',
    'X_AUDIT_SINK_MISSING',
    'X_IDEMPOTENCY_NOT_SHARED',
    'X_OUTPUT_INVALID',
    'X_RPC_FAILED',
  ],
  // tier 3 — enqueue-time and backfill faults. Raised in the worker, but also by `enqueue()`,
  // `backfill` and the operator calls, which a handler can make — so "a job runs with no socket
  // attached" does not settle them the way it settles OFF_SOCKET's worker-runtime group.
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
    'X_JOB_KEY_BUSY',
    'X_JOB_NOT_CANCELLABLE',
    'X_JOB_TENANT_REQUIRED',
    'X_OUTBOX_NO_TX',
  ],
  // tier 3 — query declaration faults, raised where a query is DEFINED. `X_QUERY_NOT_PAGEABLE` is
  // unpinned: a caller asking for page 2 of an unpageable query is a caller's mistake.
  query: [
    'X_CURSOR_VALUE_UNSUPPORTED',
    'X_QUERY_CACHE_TTL_INVALID',
    'X_QUERY_DEPRECATION_INVALID',
    'X_QUERY_FOREIGN',
    'X_QUERY_INPUT_UNENCODABLE',
    'X_QUERY_POLICY_MISSING',
    'X_QUERY_UNREGISTERED',
  ],
  // tier 3 — the two live-read faults a server RENDER can raise, inside a request, rather than a
  // sync-node frame; the frame vocabulary is OFF_SOCKET.
  realtime: ['X_LIVE_CLIENT_MISSING', 'X_LIVE_SERVER_RENDER'],
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
    'X_MAIL_ADDRESS_INVALID',
    'X_MAIL_HEADER_INVALID',
    'X_MAIL_LOCALE_MISSING',
    'X_MAIL_SEND_FAILED',
    'X_MAIL_TEMPLATE_UNKNOWN',
    'X_MAIL_TEXT_MISSING',
    'X_MAIL_TRANSFORM_FAILED',
  ],
  // tier 4 — route-declaration and prerender rules, enforced at build and at `registerRoute`.
  // `X_PRERENDER_FAILED` and `X_ROUTE_LOAD_FAILED` are the ones to look at first if this group
  // shrinks: a lazily loaded route can fail while a request is waiting on it.
  // `X_ISLAND_PROPS_INVALID` left this group 2026-09-05: it is raised INSIDE a request — every
  // ssr/stream render of the page — and an unclassified 500 blanks its cause outside dev, which
  // withholds the one sentence (the prop, its bytes) the author needs. It has a row now.
  render: [
    'X_ISLAND_INVALID',
    'X_ISLAND_NOT_HYDRATED',
    'X_PRERENDER_FAILED',
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
