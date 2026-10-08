// The pins under `scripts/error-map.ts`: every framework code owned by a tier <= 4 package that
// has NO row in `packages/http/src/error-map.ts` today, in two lists that mean opposite things.
//
// `OFF_SOCKET` is a DECISION: the code never reaches an HTTP caller — it is raised at boot or
// registration, by `x` or the build, in the worker, in the browser, or on a WebSocket / JSON-RPC
// frame that carries no status. It may grow: `bun run new-error-code … --off-socket` writes here.
//
// `UNDECIDED` is the debt: nobody has judged whether the code can reach a caller. It may shrink and
// may never grow (`error-map-backlog.test.ts` pins its size). Every entry leaves by one of two
// edits — a row in the code's status slice, or a move to `OFF_SOCKET` with the reason beside it.
//
// Why pinned and not derived: "can this code reach an HTTP caller?" is not decidable from the
// source. `X_MIGRATION_DESTRUCTIVE` and `X_TENANCY_CROSS_DENIED` are the same tier, the same shape
// and one grep apart, and only a human knows the first is a CLI-time refusal and the second is a
// request a user just made. Every `src/index.ts` re-exports everything, so no import graph
// separates them either — the classification is recorded, as `expectedRed` in
// `scripts/lib/gated-apps.ts` records the tracked apps' gate steps.

type Pins = Readonly<Record<string, readonly string[]>>;

/**
 * Decided: never an HTTP answer. Grouped by owning package, the reason above each group. This
 * literal comes FIRST in the file on purpose — `new-error-code`'s `--off-socket` writes into it.
 */
export const OFF_SOCKET: Pins = {
  // tier 0 — a registry refusing a second declaration at boot, the drain overrunning its
  // deadline, and the `.env.example` finding of `x verify`'s `manifest` step.
  core: [
    'X_ENV_EXAMPLE_DRIFT',
    'X_ERROR_CODE_DUPLICATE',
    'X_READINESS_CHECK_DUPLICATE',
    'X_REGISTRAR_CONFLICT',
    'X_SERVICE_DUPLICATE',
    'X_SHUTDOWN_TIMEOUT',
    'X_SECRETS_KEY_ACL_FAILED',
  ],
  // tier 1 — a tier's ceiling or similarity floor, screened where `app.config.ts` names it: raised
  // by `new LruCache(...)` and `memorySemanticCache(...)`, which a boot builds once.
  cache: ['X_CACHE_LIMIT_INVALID'],
  // tier 1 — `x db` commands and release-phase work, plus `close()`: the pool handle is cleared
  // before the drain's await, so nothing inside a request reaches a client that is draining.
  // `X_SCHEMA_DUMP_DRIFT` is a `drift`-step finding about files under `packages/db/schema/`.
  db: [
    'X_BRANCH_EXISTS',
    'X_DB_DRAIN_TIMEOUT',
    'X_MIGRATE_CONCURRENT',
    'X_MIGRATION_CONFLICT',
    'X_MIGRATION_DESTRUCTIVE',
    'X_MIGRATION_IRREVERSIBLE',
    'X_MIGRATION_SNAPSHOT_MISSING',
    'X_MIGRATION_VIEW_DEPENDS',
    'X_SCHEMA_DUMP_DRIFT',
    'X_APPEND_ONLY_TRIGGER_MISSING',
    'X_MIGRATION_APPEND_ONLY_BACKFILL',
  ],
  // tier 1 — a flag declared twice, at registration.
  flags: ['X_FLAG_DUPLICATE'],
  // tier 1 — catalog faults, raised by the build and by `x i18n`. The request-time one is
  // `X_LOCALE_UNSUPPORTED`, which has a row.
  i18n: ['X_CATALOG_INVALID', 'X_CATALOG_MISSING_KEYS', 'X_CATALOG_UNREGISTERED'],
  // tier 1 — `registerCurrency`'s refusals and nothing else raises them. `REGISTERED` is per
  // PROCESS: a request-driven registration lands on one replica and leaves the others answering
  // `X_CURRENCY_UNKNOWN`, so it is broken before a status could describe it. A currency that
  // arrives over the wire reaches `assertCurrency` (`X_CURRENCY_UNKNOWN`, which has a row).
  money: ['X_CURRENCY_INVALID', 'X_CURRENCY_REDEFINED'],
  // tier 2 — limiter wiring refused at boot, and an OAuth provider registered twice.
  auth: [
    'X_AUTH_LIMITER_NOT_SHARED',
    'X_AUTH_LIMITER_POLICY_MISMATCH',
    'X_OAUTH_PROVIDER_DUPLICATE',
  ],
  // tier 2 — the N+1 pair: dev notices surfaced by the overlay, never thrown at a caller.
  entity: ['X_N_PLUS_ONE_QUERY', 'X_N_PLUS_ONE_WRITE'],
  // tier 2 — a role declared twice at registration.
  policy: ['X_ROLE_REDEFINED'],
  // tier 3 — an action or its path registered twice, at `registerActions`.
  action: ['X_ACTION_DUPLICATE', 'X_ACTION_PATH_DUPLICATE'],
  // tier 3 — the worker's own runtime vocabulary. A job runs with no socket attached and
  // `ROLE=worker` opens no HTTP port. `X_JOB_CLAIM_QUEUES_EMPTY`: every shipped caller of
  // `driver.claim()` is off-socket (`worker.ts`, `x jobs drain`, `@ultimat3/testing`'s fixture)
  // and passes queues by name. `X_JOB_ROW_STATUS_UNKNOWN` is raised wherever a row is READ, and
  // has a row. Enqueue-time codes, which a handler can trip, are under UNDECIDED.
  jobs: [
    'X_JOB_CLAIM_QUEUES_EMPTY',
    'X_JOB_LEASE_LOST',
    'X_JOB_MAX_ATTEMPTS',
    'X_JOB_ON_SETTLED_FAILED',
    'X_JOB_SLOT_LOST',
    'X_JOB_TIMEOUT',
    'X_STEP_DUPLICATE',
    'X_JOB_TENANT_MISMATCH',
  ],
  // tier 3 — judged at `query()`, where the declaration is written, or on a live read: a
  // WebSocket subscription carrying a `kind`, not a request carrying a status (`live.ts`).
  query: [
    'X_MATCHER_UNSUPPORTED',
    'X_QUERY_DUPLICATE',
    'X_QUERY_SINGLE_INVALID',
    'X_QUERY_SUBSCRIBES_DRIFT',
    'X_QUERY_SUBSCRIBES_INVALID',
  ],
  // tier 3 — the sync node's own vocabulary, answered on a WebSocket frame that carries a
  // `kind` and not a status; the HTTP upgrade has none of these. Revisit the day a frame kind
  // is projected onto a status.
  realtime: [
    'X_CURSOR_STALE',
    'X_FRAME_RATE_LIMIT',
    'X_LIVE_QUERY_UNKNOWN',
    'X_LIVE_REPLICA_IDENTITY',
    'X_LIVE_ROW_UNIDENTIFIED',
    'X_OFFLINE_QUEUE_ABANDONED',
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
    'X_REALTIME_PRODUCER_CONFLICT',
  ],
  // tier 4 — a mail declared twice, at registration.
  mail: ['X_MAIL_DUPLICATE'],
  // tier 4 — build-time only: the manifest emitter and the `AGENTS.md` rules, all on `x verify`.
  manifest: [
    'X_AGENTS_MD_MISSING',
    'X_AGENTS_MD_TOO_LARGE',
    'X_MANIFEST_BREAKING',
    'X_MANIFEST_DRIFT',
    'X_MANIFEST_FACT_INVALID',
  ],
  // tier 4 — MCP answers over its own JSON-RPC envelope, which carries an error object and not
  // a status; `X_MCP_SURFACE_OVER_BUDGET` is a test helper's. Revisit if the MCP host is ever
  // mounted on an HTTP route inside the pipeline.
  mcp: [
    'X_MCP_ARGS_INVALID',
    'X_MCP_GROUP_CONFLICT',
    'X_MCP_GROUP_UNKNOWN',
    'X_MCP_LIST_PARAMS_INVALID',
    'X_MCP_NOT_BRANCH_DB',
    'X_MCP_PROTOCOL',
    'X_MCP_QUERY_REJECTED',
    'X_MCP_RESOURCE_DUPLICATE',
    'X_MCP_SCOPE_CONFLICT',
    'X_MCP_SCOPE_DENIED',
    'X_MCP_SCOPE_UNCOVERED',
    'X_MCP_SCOPE_UNKNOWN',
    'X_MCP_SURFACE_INVALID',
    'X_MCP_SURFACE_OVER_BUDGET',
    'X_MCP_TOOL_DUPLICATE',
    'X_MCP_TOOL_UNDECLARED',
    'X_MCP_TOOL_UNKNOWN',
    'X_MCP_TOOL_UNSAFE',
    'X_MCP_CONFIRMATION_TOOL_UNKNOWN',
  ],
  // tier 4 — the service worker and the PWA manifest: build-time rules, faults raised in the
  // BROWSER, where there is no response to give a status to, and the VAPID pair refused at BOOT,
  // before a listener exists. The send-time push faults have rows (`error-map-tier-4.ts`).
  pwa: [
    'X_BUILD_ID_MISSING',
    'X_PWA_ICON_MISSING',
    'X_PWA_MANIFEST_INVALID',
    'X_PWA_NO_OFFLINE_FALLBACK',
    'X_PWA_STRATEGY_EXHAUSTED',
    'X_PWA_SYNC_FLUSH_FAILED',
    'X_PWA_SYNC_INCOMPLETE',
    'X_SW_SCOPE_INVALID',
    'X_PWA_VAPID_KEY_MISSING',
    'X_PWA_VAPID_KEY_INVALID',
  ],
  // tier 4 — the build's budget, a route file refused by `registerRoute`, and `openModal`'s
  // refusal, thrown in the browser by the code that called it — no request carries it.
  render: [
    'X_BUDGET_EXCEEDED',
    'X_ROUTE_DUPLICATE',
    'X_ROUTE_FILE_INVALID',
    'X_NAVIGATION_MODAL_PATH_INVALID',
  ],
  // tier 4 since 26.0.0 (#709) — `scrape()` returns a job: every code is raised in the worker,
  // which opens no HTTP port, or at declaration, at boot.
  scraping: [
    'X_SCRAPE_AUTH_FAILED',
    'X_SCRAPE_BLOCKED',
    'X_SCRAPE_BODY_TOO_LARGE',
    'X_SCRAPE_BROWSER_MISSING',
    'X_SCRAPE_BROWSER_UNREACHABLE',
    'X_SCRAPE_CAPTURE_INVALID',
    'X_SCRAPE_CDP_ATTACH_FAILED',
    'X_SCRAPE_DOWNLOAD_TIMEOUT',
    'X_SCRAPE_DRIVER_UNKNOWN',
    'X_SCRAPE_EGRESS_IN_PAYLOAD',
    'X_SCRAPE_EGRESS_UNSUPPORTED',
    'X_SCRAPE_FIXTURE_MISSING',
    'X_SCRAPE_FIXTURE_STALE',
    'X_SCRAPE_HOST_BLOCKED',
    'X_SCRAPE_HTTP_FAILED',
    'X_SCRAPE_KEY_INVALID',
    'X_SCRAPE_LAUNCH_ARGS_INVALID',
    'X_SCRAPE_NOT_ACTIONABLE',
    'X_SCRAPE_OUTPUT_INVALID',
    'X_SCRAPE_PAGE_CRASHED',
    'X_SCRAPE_PROFILE_LOCKED',
    'X_SCRAPE_PROMPT_UNANSWERED',
    'X_SCRAPE_RECOVER_REFUSED',
    'X_SCRAPE_REDIRECT_LOOP',
    'X_SCRAPE_REMOTE_REQUIRED',
    'X_SCRAPE_ROBOTS_DISALLOWED',
    'X_SCRAPE_SECRET_EXPOSED',
    'X_SCRAPE_SELECTOR_MISSING',
    'X_SCRAPE_SESSION_EXPIRED',
    'X_SCRAPE_TIMEOUT',
    'X_SCRAPE_WATCHDOG_STOPPED',
    'X_SCRAPE_WEDGED',
    'X_SCRAPE_YIELD_COLLAPSED',
    'X_SCRAPE_YIELD_HISTORY_MISSING',
  ],
  schema: ['X_SCHEMA_BOUNDS_INVALID'],
};

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

const merged = (...lists: readonly Pins[]): Pins => {
  const out = new Map<string, readonly string[]>();
  for (const list of lists) {
    for (const [owner, codes] of Object.entries(list)) {
      out.set(owner, [...(out.get(owner) ?? []), ...codes]);
    }
  }
  return Object.fromEntries(out);
};

/** Both lists, per owner — what the gate reads: a pin of either kind is "no row, on purpose". */
export const ERROR_STATUS_BACKLOG: Pins = merged(OFF_SOCKET, UNDECIDED);

/** Every pinned code, flat. The owner grouping is for the reader; the rule is per code. */
export const backlogCodes = (
  backlog: Readonly<Record<string, readonly string[]>> = ERROR_STATUS_BACKLOG,
): ReadonlySet<string> => new Set(Object.values(backlog).flat());

/** Which group an entry sits in, so a `fix:` can name the exact line to delete. */
export const backlogGroupOf = (
  code: string,
  backlog: Readonly<Record<string, readonly string[]>> = ERROR_STATUS_BACKLOG,
): string | undefined => Object.entries(backlog).find(([, codes]) => codes.includes(code))?.[0];
