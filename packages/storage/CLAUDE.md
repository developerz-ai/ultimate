# @ultimat3/storage — agent notes

Tier 1. Object storage: named disks, safe keys, signed URLs, sniffed uploads.

- May import: `@ultimat3/core`, `@ultimat3/schema`. Nothing else. No npm dependencies.
- Must NOT know about HTTP, entities, actions, render — a route calls `acceptSignedUpload()`,
  this package never owns one. Consumers: `http`, `seo`, `admin`, `cli`.
- **The line is a `Request`/`Response`/status, not a URL string.** `accept.ts` takes a url, bytes
  and a content-type string and answers with a `StorageObject` or throws; the caller turns that
  into a response, because `@ultimat3/http`'s `error-map.ts` is the only place a code becomes a
  status. A handler here would be a second status table.
- **Tier 1 is why there is no `uploadAction()`.** `action` is tier 3, so this package cannot
  return one — `llm()` works only because `@ultimat3/ai` sits *above* `action`. The shape that
  fits the table is `@ultimat3/auth`'s: ship the server function (`grantUpload`), let the app
  wrap it in its own `action()` with its own policy. See `docs/architecture/17-uploads.md`.

| Rule | |
|---|---|
| Errors | `StorageError` + one factory per code in `errors.ts`; never `throw new Error` |
| New code | add to `STORAGE_ERROR_CODES` **and** `STORAGE_ERROR_TITLES` |
| Keys | every driver method starts with `assertSafeKey()`. No exceptions, no sanitising. `META_DIR` (`.meta`) is a reserved first segment on every driver — see below |
| Time | take a `Clock`; never `Date.now()` |
| Bytes | `Uint8Array \| ReadableStream \| Blob`. Never a base64 string |
| Exports | explicit in `src/index.ts`; no `export *` |

| File | Owns |
|---|---|
| `driver.ts` | `StorageDriver` contract + `toBytes`/`sha256Base64`/`etagOf` |
| `driver-local.ts` | dev default over `Bun.file`, `.meta/` sidecars, `Bun.Glob` listing |
| `driver-s3.ts` | `Bun.S3Client`, built lazily (import must never open a socket) |
| `path.ts` | key validation + `META_DIR` + `scopedKey`/`isWithinOrg`/`isTenantScoped` tenant boundary |
| `signed-url.ts` | HMAC over the constraint tuple, constant-time verify |
| `upload.ts` | magic-byte sniff + size/allowlist/checksum policy |
| `image.ts` | deterministic variant keys; byte path over core's pipeline (png/jpeg encode only) |
| | `variantKey` is the cache identity `@ultimat3/cli`'s `/media/*` route looks a variant up by — derived, never stored, so a request that misses transforms once and every later one is a disk read |
| `storage.ts` | `defineStorage` + module-level `storage()` / `disk()` |
| `grant.ts` | `grantUpload` — the ONE way a presigned PUT is minted; the client never names a key |
| `accept.ts` | `acceptSignedUpload` / `readSignedObject` — the two decisions a `/_storage` route is made of |
| `attachment.ts` | `pending/` → row promotion, the entity key convention, and `sweepOrphans` |
| `upload-client.ts` | the browser half: grant → PUT with progress → key. No `Bun.*`, no `node:` |

```bash
bun test                      # from packages/storage
bun run typecheck
```

Gotchas:
- **`META_DIR` lives in `path.ts`, not in `driver-local.ts`.** The sidecar namespace overlapped the
  object namespace: `put('a/b', png)` writes `<root>/.meta/a/b.json`, and `.meta/a/b.json` was
  itself a legal key, so an uploader could rewrite another object's recorded `contentType` to
  `text/html` and have a route serve attacker HTML from the app's origin. Reserved in
  `assertSafeKey`, so it holds for S3 too — a key valid on one driver and refused on another is two
  key rules. The `list()` skip stays as a second line of defence.
- **`localDriver` refuses to construct outside development without `STORAGE_SIGNING_SECRET`**
  (`X_ENV_MISSING`, borrowed from core). `DEV_SIGNING_SECRET` is published in this repo, and
  `acceptSignedUpload` trusts a signed URL's constraints over the app's `uploadPolicy` — so the
  fallback is a universal grant to mint any `PUT`. Refused at construction, not at the first
  `signedUrl()`: a process that cannot sign safely must not finish booting. `usesDevStorageSecret()`
  is the `x doctor` predicate, mirroring core's `usesDevCursorSecret()`; it reads the env var, so a
  disk handed an explicit `signingSecret` is outside its question.
- **The mounted read half is `@ultimat3/cli`'s `dev-storage.ts`, not this package.** `GET
  /_storage/:disk/*key` gates on `@ultimat3/policy`'s `evaluate()` (`storage:read`), which is tier
  2 and unreachable from here — so a "serve this object" helper in this package could only ever be
  a second authz path. This package's contribution to that route is `assertSafeKey`,
  `isTenantScoped`/`isWithinOrg` and the driver's own `contentType`/`etag`; the `Response` is the
  host's, exactly as `accept.ts`'s header says.
- `acceptSignedUpload` still has no mounted route: the signing secret is closed over inside
  `localDriver` and no `StorageDriver` method exposes it, so a host cannot verify a signed PUT
  through the `Storage` seam it is handed. Serving reads needed none of it (policy decides, not a
  signature); mounting the write half needs that seam question answered first.
- `X_NOT_IMPLEMENTED` is core's — it belongs in `STORAGE_BORROWED_ERROR_CODES` (codes, no title)
  and never in the registration call. A `hasErrorCode()` guard there would suppress the
  `X_ERROR_CODE_DUPLICATE` two owners of one code are supposed to get. Tests need `resetStorage()`
  in `beforeEach`.
- `image.ts` owns no pixels: core's `transformImageBytes`/`blurDataUrl` are the only scaler.
  Its image failures (`X_IMAGE_UNSUPPORTED`, `X_IMAGE_DECODE_FAILED`) surface unwrapped —
  wrapping them in a `StorageError` would give one failure two codes.
- `transformImage()` must encode at exactly `fitDimensions()`'s size, and passes `format`
  explicitly (`?? 'webp'`, which then rejects): bytes that disagree with the `variantKey`
  extension, or with the `width`/`height` `@ultimat3/seo` inlined, are the layout shift the
  whole path exists to prevent. That is why it derives the box itself and asks core for
  `fit: 'cover'` — core's `contain` letterboxes to the requested box, this API fits inside it.
- Bun's S3 flag is `virtualHostedStyle`; our `forcePathStyle` is its inverse.
- The signature check runs BEFORE the expiry check. Do not reorder.
- `timingSafeEqual` is `@ultimat3/core`'s (`signed-url.ts` imports and re-exports it) — the same
  implementation `@ultimat3/auth` uses, not a second copy. Add new secret comparisons through it.
- `verifySignedUrl` never throws, and `parseConstraints` is where that is kept: the key is decoded
  through the guarded `decodeSegment`, so a `%ZZ` in the path is `'malformed'` rather than the bare
  `URIError` `decodeURIComponent` raises. Same shape as `@ultimat3/auth`'s `decodeCookieValue`.
- `acceptSignedUpload` refuses a URL signed with **no** content type (`unconstrained`). `grantUpload`
  always sets one, so such a URL is hand-rolled, and trusting the uploader's header instead is the
  only other option.
- `orgId` is required on both halves of `accept.ts` and is the ACTOR's, never a request field. A
  signed URL is a capability; a leaked capability must still not cross a tenant.
- `X_STORAGE_ORG_MISMATCH` maps to **404**, not 403 (`@ultimat3/http`'s `error-map.ts`). 403 would
  confirm a key exists to the one caller who must not learn it.
- The local driver reports the **filesystem's** `lastModified`, not the injected `Clock`, so
  `sweepOrphans` cannot be tested against it with a frozen clock — `attachment.test.ts` uses a
  stub driver with authored timestamps, and `driver-local.test.ts` proves the disk half.
- `upload-client.ts` defaults to `XMLHttpRequest`, not `fetch`: `fetch` reports no upload
  progress in any shipping browser, and a bar that jumps 0 → 100 is a bar that is lying.
- `exactOptionalPropertyTypes` is on — declare optional fields as `x?: T | undefined`.
