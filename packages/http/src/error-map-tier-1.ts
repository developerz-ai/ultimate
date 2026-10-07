// One slice of the status table `error-map.ts` composes: tier 1 — `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage`, `flags`.
// A row here is a code owned by a tier-1 package; `bun run new-error-code` appends to the slice its
// `--package` belongs to, so no one file grows with every code the framework adds.

export const TIER_1_ERROR_STATUS = {
  // @ultimat3/db — the constraints a request trips, both 409. db's own `fix:` for the unique
  // violation says "answer 409, which is what a raced signup is", and `X_ENTITY_DUPLICATE` — the
  // same event one layer up — is 409 above; a foreign key rides with it because both halves of it
  // are a conflict with the state that is there (the parent is missing, or the child still points
  // at it), which 422 describes only for the insert.
  X_DB_UNIQUE_VIOLATION: 409,
  X_DB_FOREIGN_KEY_VIOLATION: 409,
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
  // 409 for the same reason: `promoteAttachment` on a key that is not a pending upload — promoted
  // twice, or never uploaded — is a state the caller can see and fix, not a server fault.
  X_STORAGE_NOT_PENDING: 409,
  // 404, deliberately NOT 403: the org check fires before anything is read, so answering
  // "forbidden" would confirm that a key exists to the one caller who must not learn it.
  X_STORAGE_ORG_MISMATCH: 404,
  // @ultimat3/seo — a `meta.links` entry an `ssr` page's `meta()` built from data: an unsafe href,
  // a preload with no `as`. Thrown while that request renders its head, so it reaches the caller —
  // an authoring defect, never the visitor's, hence 500 with the cause naming the link intact.
  X_SEO_LINK_INVALID: 500,
  // @ultimat3/db — the server rolled the transaction back
  X_DB_TRANSACTION_ABORTED: 500,
  // @ultimat3/db — the connection was lost while COMMIT was in flight
  X_DB_COMMIT_UNKNOWN: 500,
  // @ultimat3/db — a nested transaction scope waited too long for its sibling
  X_DB_SIBLING_SCOPE_TIMEOUT: 500,
  // @ultimat3/storage — the key collides with another key on the local disk
  X_STORAGE_KEY_CONFLICT: 409,
  // @ultimat3/storage — the object could not be written
  X_STORAGE_PUT_FAILED: 500,
  // @ultimat3/storage — the object could not be read
  X_STORAGE_READ_FAILED: 500,
  // @ultimat3/storage — the object is under retention or a legal hold
  X_STORAGE_OBJECT_LOCKED: 409,
  // @ultimat3/cache — a cached value the cache codec cannot encode (a cycle). The stack absorbs it
  // through `bestEffort`; only a direct `LruCache.set` in a handler reaches a socket, and that is
  // an authoring defect in the server's own code, never the caller's — hence 500.
  X_CACHE_VALUE_UNENCODABLE: 500,
} satisfies Readonly<Record<string, number>>;
