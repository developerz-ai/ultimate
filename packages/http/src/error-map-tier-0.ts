// One slice of the status table `error-map.ts` composes: tier 0 — `core`, `schema`.
// A row here is a code owned by a tier-0 package; `bun run new-error-code` appends to the slice its
// `--package` belongs to, so no one file grows with every code the framework adds.

export const TIER_0_ERROR_STATUS = {
  // @ultimat3/core (declared beside `assertLocale`; `@ultimat3/time` owned it until 16.x) — the
  // sibling of the row above, and strictly more the caller's fault: not a tag at all. It was
  // pinned as unable to reach a request because the `locale` stage negotiates and never throws,
  // which is true of that stage and irrelevant to `?locale=`, a path segment or an action input
  // reaching `formatDate` / `formatMoney` / `describeCron`. Those raised it and answered 500,
  // paging the on-call for a string the caller typed.
  X_LOCALE_INVALID: 400,
  // @ultimat3/core — `seal()` / `open()`. All three are reachable from a request (a sealed column
  // read inside an action) and none is the caller's doing: the deploy has no key, the ring lost a
  // retired key, or a stored value did not authenticate. 500, stated rather than defaulted.
  X_SEAL_INVALID: 500,
  X_SEAL_KEY_MISSING: 500,
  X_SEAL_KEY_UNKNOWN: 500,
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
  // Plan 101's client seam. A typed call made from a server handler: an upstream that gave no usable
  // answer is 502, the fence is `X_SUPERSEDED`'s twin. The rest are browser-side or declaration-time
  // refusals no request carries; their rows keep the table closed.
  X_CLIENT_TRANSPORT_FAILED: 502,
  X_CLIENT_RECORD_ENVELOPE_INVALID: 502,
  X_CLIENT_SCOPE_CHANGED: 499,
  X_CHANNEL_DECLARATION_INVALID: 500,
  X_LOCAL_STORE_UNAVAILABLE: 500,
  X_MUTATOR_CLOCK_MISSING: 500,
  X_REALTIME_UNINSTALLED: 500,
  // Boot-time: a realtime config and its environment that disagree refuse before any request.
  X_REALTIME_TOPOLOGY: 500,
  // The replicator's own Postgres connection failed TLS. A role that never answers a request, so the
  // row keeps the table closed at 500, beside `X_REALTIME_TOPOLOGY`.
  X_REPLICATION_TLS: 500,
  // A browser page on a foreign origin asked for a socket — refused, not unauthenticated: 403.
  X_SOCKET_ORIGIN_REFUSED: 403,
  X_RECORD_KEY_MISSING: 500,
  X_RECORD_REJECTED: 500,
  X_SYNC_UNCONFIGURED: 500,
  X_INTERNAL: 500,
  // @ultimat3/core — a Set-Cookie value would be dropped, misread or injectable
  X_COOKIE_INVALID: 500,
} satisfies Readonly<Record<string, number>>;
