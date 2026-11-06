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
// separates them either — the classification is recorded, as `expectedRed` is (`gated-apps.ts`).

import { UNDECIDED } from './lib/error-map-undecided';

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
    'X_OUTBOUND_RETRY_UNSAFE',
    'X_ERROR_DECLARATION_INVALID',
    'X_CLIENT_ERROR',
    // Raised by `checkDeclaredErrors` at `action()`/`query()`: a module's load, never a request.
    'X_ACTION_ERRORS_INVALID',
    // Both raised by `runExercise` (`exercise-run.ts`) inside a test's `.exercise()` call — a test
    // run, never a request or a module's load. This one: the environment is staging or production.
    'X_CONTRACT_EXERCISE_ENVIRONMENT',
    // This one: outside `test`, no rolled-back transaction would undo the writes
    // (`assertExerciseScoped`, fed `rollbackAvailable()` by `action`'s `exercise.ts`).
    'X_CONTRACT_EXERCISE_UNSCOPED',
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
    'X_MIGRATION_CONCURRENT_IN_TRANSACTION',
    'X_MIGRATION_ROLLING_UNSAFE',
    'X_DB_POOLER_SESSION_REQUIRED',
    'X_DB_STATEMENT_BOUND_LOST',
    'X_DB_STATEMENT_BOUND_INVALID',
    'X_MIGRATION_CONCURRENT_PARTITIONED',
    'X_DB_ROW_SECURITY_BYPASSED',
    'X_DB_ROW_SECURITY_DRIFT',
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
    'X_AUTH_SIGN_IN_UNCONFIGURED',
    'X_AUTH_SERVER_INVALID',
    'X_AUTH_GRANT_DISABLED',
    'X_VERIFICATION_PURPOSE_INVALID',
  ],
  // tier 2 — the N+1 pair: dev notices surfaced by the overlay, never thrown at a caller.
  entity: [
    'X_N_PLUS_ONE_QUERY',
    'X_N_PLUS_ONE_WRITE',
    'X_LOCK_UNSUPPORTED',
    'X_TEST_DRIVER_CLIENT_CHANGED',
    'X_ENTITY_TENANT_UNDECLARED',
  ],
  // tier 2 — a role declared twice at registration.
  policy: ['X_ROLE_REDEFINED'],
  // tier 3 — an action or its path registered twice, at `registerActions`.
  action: [
    'X_ACTION_DUPLICATE',
    'X_ACTION_PATH_DUPLICATE',
    'X_CONTRACT_DEFECT',
    'X_CONTRACT_EXERCISE_UNREACHED',
    'X_CONTRACT_EXERCISE_UNDECLARED',
  ],
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
    'X_STEP_OUTPUT_UNSERIALIZABLE',
    'X_JOB_EVENT_INVALID',
    'X_IMPORT_HEADER_MISMATCH',
    'X_IMPORT_RECORD_TOO_LARGE',
    'X_IMPORT_TOO_MANY_ERRORS',
    'X_JOB_ENQUEUE_BATCH_TOO_LARGE',
    'X_WEBHOOK_RECEIVER_INVALID',
    'X_JOB_COMPENSATION_FAILED',
    'X_STEP_OUTCOME_UNKNOWN',
    'X_CONSUMER_INVALID',
    'X_CONSUMER_SELF_ENQUEUE',
    'X_BACKFILL_SOURCE_INVALID',
    'X_STEP_NOT_RESOLVABLE',
  ],
  // tier 3 — judged at `query()`, where the declaration is written, or on a live read: a
  // WebSocket subscription carrying a `kind`, not a request carrying a status (`live.ts`).
  query: [
    'X_MATCHER_UNSUPPORTED',
    'X_QUERY_DUPLICATE',
    'X_QUERY_SINGLE_INVALID',
    'X_QUERY_SUBSCRIBES_DRIFT',
    'X_QUERY_SUBSCRIBES_INVALID',
    'X_QUERY_DOWNLOAD_INVALID',
    'X_QUERY_ETAG_INVALID',
    'X_QUERY_TIMEOUT_INVALID',
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
    // Not a frame: raised in the browser by `mutationWire` (`pinned-wire.ts`) before the write is
    // sent, when the input leaves a pinned path's `:param` unfilled. No request leaves the page.
    'X_MUTATION_PATH_UNFILLED',
  ],
  // tier 4 — a test double's script running out, raised inside `bun test` by `scriptedProvider`,
  // which no served app installs.
  ai: ['X_AI_SCRIPT_EXHAUSTED', 'X_EVAL_TOOL_UNDOUBLED'],
  // tier 4 — a mail declared twice, at registration.
  mail: ['X_MAIL_DUPLICATE', 'X_MAIL_KEY_MISSING'],
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
    'X_MCP_EFFECT_UNDECLARED',
    'X_MCP_EFFECT_CONFLICT',
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
  schema: ['X_SCHEMA_BOUNDS_INVALID', 'X_SCHEMA_SENSITIVE_OUTPUT'],
};

/** Undecided, shrink-only: `scripts/lib/error-map-undecided.ts`, re-exported here. */
export { UNDECIDED } from './lib/error-map-undecided';

const merged = (...lists: readonly Pins[]): Pins => {
  const out = new Map<string, readonly string[]>();
  for (const [owner, codes] of lists.flatMap((list) => Object.entries(list))) {
    out.set(owner, [...(out.get(owner) ?? []), ...codes]);
  }
  return Object.fromEntries(out);
};

/** Both lists, per owner — what the gate reads: a pin of either kind is "no row, on purpose". */
export const ERROR_STATUS_BACKLOG: Pins = merged(OFF_SOCKET, UNDECIDED);

/** Every pinned code, flat. The owner grouping is for the reader; the rule is per code. */
export const backlogCodes = (backlog: Pins = ERROR_STATUS_BACKLOG): ReadonlySet<string> =>
  new Set(Object.values(backlog).flat());

/** Which group an entry sits in, so a `fix:` can name the exact line to delete. */
export const backlogGroupOf = (
  code: string,
  backlog: Readonly<Record<string, readonly string[]>> = ERROR_STATUS_BACKLOG,
): string | undefined => Object.entries(backlog).find(([, codes]) => codes.includes(code))?.[0];
