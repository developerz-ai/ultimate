// One slice of the status table `error-map.ts` composes: tier 4 — `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail`, `ui`, `notify`.
// A row here is a code owned by a tier-4 package; `bun run new-error-code` appends to the slice its
// `--package` belongs to, so no one file grows with every code the framework adds.

export const TIER_4_ERROR_STATUS = {
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
  // @ultimat3/ui — `defineTheme()` refused a brand palette whose RESOLVED channels put a pairing
  // below WCAG 2.2 AA. Declaration-time in the ordinary case, and it takes a row rather than a
  // backlog entry for the one case that is not: an app that renders a per-tenant brand stylesheet
  // during a request throws this ON that request. The author's fault and never the caller's, so
  // 500 is the honest class, and a DECLARED 500 rather than an unclassified one — `toProblem`
  // blanks the cause of an unclassified failure outside dev, which would hide the one thing that
  // makes this error actionable: the role and the measured ratio.
  X_UI_CONTRAST_INSUFFICIENT: 500,
  // @ultimat3/ui — `<QrCode>` was handed a value past the encoder's version-3 ceiling. The value
  // is the app's own (a short URL it minted), never the caller's, so 500 is the honest class —
  // and a declared 500 for the contrast code's reason: `toProblem` blanks an unclassified
  // failure's cause outside dev, and the cause is where the byte count and the ceiling are.
  X_UI_QR_CAPACITY: 500,
  // @ultimat3/render — an island handed props it cannot carry: an undeclared key, a value that is
  // not JSON, or a bag over `ISLAND_PROPS_MAX_BYTES`. The author's fault and never the caller's,
  // so 500 is the honest class — and it HAS to be a declared 500. Without a row the code was an
  // unclassified failure, and `toProblem` blanks the cause of one of those outside dev
  // (`isUnclassifiedFailure`): a 34-row catalog over the cap took a page down with a problem
  // document that said "the details are in this process's logs" about an error whose whole
  // value is the sentence naming the prop and its bytes. Measured on ai-maxxing, 2026-09-05.
  X_ISLAND_PROPS_INVALID: 500,
  // A loader answered `withStatus` with a 3xx, or a status outside 200–599. Raised INSIDE the
  // request that ran the loader, so it needs a row for the same reason the line above does: an
  // unclassified 500 blanks the sentence naming the status and the `redirect()` to use instead.
  X_ROUTE_STATUS_INVALID: 500,
  // `asset('assets/…')` named a file that is not on disk. The static build refuses it, but an `ssr`
  // page calls `asset()` INSIDE the request it renders, so it reaches a caller there — a deploy
  // defect, never the visitor's, hence 500, declared so the cause naming the missing file survives.
  X_ASSET_MISSING: 500,
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
  // The second MCP code answered on a request before dispatch, and 413 for the same reason the row
  // above is 429: `transport-http.ts` already answers it with that status by hand.
  X_MCP_BODY_TOO_LARGE: 413,
  // @ultimat3/ai — a vector store was read with no tenant bound inside an org request
  X_VECTOR_UNSCOPED: 500,
  // @ultimat3/ai — an image or document block the role, model or wire format cannot take
  X_AI_CONTENT_UNSUPPORTED: 422,
  // @ultimat3/mcp — a gated MCP tool call waits for a person to approve it
  X_MCP_CONFIRMATION_PENDING: 409,
  // @ultimat3/mcp — an MCP confirmation expired before it was used or decided
  X_MCP_CONFIRMATION_EXPIRED: 410,
  // @ultimat3/mcp — a person rejected this MCP tool call
  X_MCP_CONFIRMATION_REJECTED: 403,
  // @ultimat3/mcp — an MCP confirmation was already decided
  X_MCP_CONFIRMATION_DECIDED: 409,
  // @ultimat3/mcp — no MCP confirmation has that id
  X_MCP_CONFIRMATION_UNKNOWN: 404,
  // @ultimat3/mcp — identical concurrent MCP calls kept racing one confirmation
  X_MCP_CONFIRMATION_CONTESTED: 503,
  // @ultimat3/mail — a delivery notification is not signed by its provider
  X_MAIL_EVENT_UNVERIFIED: 401,
  // @ultimat3/mail — a delivery notification is not a shape this receiver reads
  X_MAIL_EVENT_INVALID: 400,
  // @ultimat3/mail — an SNS endpoint the receiver needed did not answer
  X_MAIL_EVENT_PROVIDER_UNREACHABLE: 503,
  // @ultimat3/mcp — an MCP confirmation approval did not carry the arguments the agent sent
  X_MCP_CONFIRMATION_ARGUMENTS_MISMATCH: 409,
  // @ultimat3/ai — a model call named no model
  X_AI_MODEL_UNRESOLVED: 500,
} satisfies Readonly<Record<string, number>>;
