// One slice of the status table `error-map.ts` composes: tier 3 — `action`, `query`, `jobs`, `realtime`.
// A row here is a code owned by a tier-3 package; `bun run new-error-code` appends to the slice its
// `--package` belongs to, so no one file grows with every code the framework adds.

export const TIER_3_ERROR_STATUS = {
  // @ultimat3/action — the code every primitive throws when the CALLER's input fails the schema
  // the primitive declared. 400 because that is what the published OpenAPI operation promises for
  // it, and because a missing row made a typo'd uuid a 500: the caller was told the server broke,
  // and the `error-map` stage reported the caller's mistake to the on-call monitor.
  X_INPUT_INVALID: 400,
  // The one way a SERVER answers this code: a POST to the path an action has under a path style
  // this app does not serve (`hooks.explainMiss`). 404 because it is still a miss — nothing is
  // routed there and nothing ran, so the status a proxy or a monitor counts is the one the plain
  // `X_ROUTE_NOT_FOUND` had; the code and the `fix:` are what changed. Every other raise of it is
  // client-side or a contract test, and never reaches this table.
  X_CONTRACT_DRIFT: 404,
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
  // @ultimat3/jobs — the ONE jobs code with a row here, and the reason the rest are pinned in
  // `scripts/error-map-backlog.ts` does not cover it. That pin says "a job runs with no socket
  // attached; `ROLE=worker` opens no HTTP port at all" — true of `X_JOB_TIMEOUT` and every other
  // worker-runtime code, and NOT true of a decode failure: `toJobRecord` runs wherever a row is
  // READ, which includes the admin dashboard's job panel and `x jobs show` served over HTTP.
  // 500, and it should page: a queue holding rows this build cannot read is an operator's
  // problem, and nothing the caller sent is wrong.
  X_JOB_ROW_STATUS_UNKNOWN: 500,
  // A requeue of a job that is still live — the admin panel's retry, `x jobs retry` over HTTP. The
  // job's STATE is wrong, not the server: 409, like `X_STORAGE_QUARANTINED`.
  X_JOB_NOT_REQUEUEABLE: 409,
  // Thrown by `job()` at declaration, while modules load; no request is answered with it. The row
  // exists for `X_ACTION_JOB_UNBRIDGED`'s reason: the table is closed, and it is a 500 anyway.
  X_JOB_DECLARATION_INVALID: 500,
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
  // @ultimat3/query — the read declares no id, so no cursor can name a position in it. The one
  // paging failure that is NOT the caller's: the fix is an edit to the read's own select, nothing
  // the client sends changes the answer, and the report to the on-call monitor is the point.
  X_QUERY_NOT_PAGEABLE: 500,
  // A read filtering or sorting on a column its loader never selected: the fix is the loader's
  // `select`, nothing the caller sends changes it — the same server-side decision as the row above.
  X_QUERY_COLUMN_UNSELECTED: 500,
  // @ultimat3/jobs — the job is running and cannot be removed
  X_JOB_NOT_REMOVABLE: 409,
  // @ultimat3/jobs — the job is not waiting on its run time
  X_JOB_NOT_PROMOTABLE: 409,
  // @ultimat3/jobs — a job list page was asked for outside its bounds
  X_JOB_PAGE_INVALID: 400,
  // @ultimat3/action — a mutator is declared without idempotent: true
  X_MUTATOR_NOT_IDEMPOTENT: 500,
  // @ultimat3/action — an idempotent action's reservation was taken over before its transaction could settle it
  X_IDEMPOTENCY_RESERVATION_LOST: 409,
  // @ultimat3/jobs — the queue holds no job with this id
  X_JOB_NOT_FOUND: 404,
  // @ultimat3/realtime — one principal holds too many sockets on this node
  X_SOCKET_LIMIT: 429,
} satisfies Readonly<Record<string, number>>;
