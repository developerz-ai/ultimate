# @ultimat3/storage — agent notes

Tier 1. Object storage: named disks, safe keys, signed URLs, sniffed uploads.
A rule marked `†` has its full text in [`docs/history/storage-rules.md`](../../docs/history/storage-rules.md).

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

- **Every byte ceiling and every TTL is screened where it is DECLARED, through core's
  `finiteCount` and nothing else** — `uploadPolicy({ maxBytes })`, every driver's `maxPutBytes`
  and `maxGetBytes`, variant `width`/`height`, `grantUpload({ expiresInMs })`, `buildSignedUrl`
  and the s3 presign TTL. No private copy:
  `size > NaN` is false, so an unscreened `NaN` ceiling stops deciding anything. Variant `quality`
  is core's `assertFiniteImageQuality`, not a second screen.
- **The default is taken on `undefined` and on nothing else** — `x === undefined ? D : x`, never
  `x ?? D`: `??` defaults a blanked `null` before the screen can refuse it.

- **`MAX_KEY_LENGTH` is UTF-8 BYTES, measured in bytes** — S3's limit. A UTF-16 `length` passed
  400 CJK characters (1,200 bytes) that the store then refused. Same fix as `@ultimat3/cache`'s
  surrogate-key guard.

| Rule | |
|---|---|
| Errors | `StorageError` + one factory per code in `errors.ts`; never `throw new Error` |
| New code | add to `STORAGE_ERROR_CODES` **and** `STORAGE_ERROR_TITLES` |
| Keys | every driver method starts with `assertSafeKey()`. No exceptions, no sanitising. `META_DIR` (`.meta`) is a reserved first segment on every driver — see below |
| Time | take a `Clock`; never `Date.now()` |
| Bytes | `Uint8Array \| ReadableStream \| Blob`. Never a base64 string, never unbounded — `toBytes(body, limit)` |
| Exports | explicit in `src/index.ts`; no `export *`. `./adapter` (`adapter.ts`): `StorageDriver`, its shapes, the errors and helpers a driver raises with — the `storage` port; no installer (the boot reads `runtime.ts`'s `storage` driver as its default disk); the `uploadScanner` port + installer |

| File | Owns |
|---|---|
| `driver.ts` | `StorageDriver` contract (11 methods; `registerAs`/`verifySigned`/`retentionOf` optional), `assertPutOptions`, + bounded `toBytes`/`sha256Base64`/`etagOf` |
| `byte-pump.ts` / `put-stream.ts` | the one counting read, `put()`'s and `putStream`'s; the `putStream` screen and limit |
| `multipart.ts` / `driver-s3-multipart*.ts` / `driver-s3-put-stream.ts` | part arithmetic + `MultipartCapability`; the six signed calls + s3's capability; the pump |
| `grant-multipart.ts` / `upload-client-multipart.ts` / `accept-part.ts` / `multipart-staged.ts` | uploads in parts: server calls, browser, local part PUT, local/memory sessions |
| `expire.ts` | `expireObjects`, `abortStaleUploads`, `objectPurgeTarget` |
| `driver-local-stream.ts` / `driver-s3-sse.ts` / `errors-stream.ts` | the staged local stream; the s3 SSE refusal; the stream codes |
| `driver-s3-settle.ts` | a lost Complete/PUT answer, settled by a stat (size + S3's etag of the bytes sent: MD5, or MD5-of-part-MD5s `-N`), then for multipart by an abort (204 = was open, nothing stored; 404 = completed, stat again). Neither settles: `X_STORAGE_WRITE_OUTCOME_UNKNOWN`, never `X_STORAGE_PUT_FAILED`. Plain `put()` settles the same way (`settleLostPut`); `isAnswered` (coded, or Bun's `S3Error`) is what counts as the provider answering |
| `range.ts` | `get(key, { range })`: screen + `servedRange` (`errors-range.ts`); s3's one-GET read is `driver-s3-range.ts` |
| `driver-local.ts` | dev default over `Bun.file`, `.meta/` sidecars; listing is `driver-local-list.ts` (`Bun.Glob`, cursor, `listFailed`), removal `driver-local-remove.ts` (a refused unlink vs one already gone) |
| `driver-local-write.ts` | the local WRITE: staged under `.meta/.tmp/`, renamed marker → sidecar → bytes, `X_STORAGE_KEY_CONFLICT` / `X_STORAGE_PUT_FAILED`, the per-key queue |
| `driver-local-read.ts` | `headObject`: sidecar + pending marker → trusted, re-checked, or untyped |
| `driver-local-sidecar.ts` | the sidecar shape and its one parser |
| `signing-secret.ts` | `DEV_SIGNING_SECRET`, `usesDevStorageSecret`, `resolveSigningSecret` |
| `driver-memory-conflict.ts` | `claim()`'s conflict rule over keys |
| `driver-memory.ts` | `memoryStorageDriver()` — a test's disk over a `Map`: `localDriver`'s contract and refusals, `objects()` for an assertion about the bucket. `driver-memory.test.ts` runs each claim on BOTH disks. Signs through `resolveSigningSecret` (`signing-secret.ts`), the one rule both share |
| `driver-s3.ts` | the s3 disk: Bun where it can, the signed wire where it cannot |
| `driver-s3-client.ts` | `S3*Like` + `buildClient`, lazy (import never opens a socket) |
| `driver-s3-signed.ts` | signed requests: Bun's addressing restated, `requireEnv`, `fetch`, refusal as `S3Error` fields |
| `driver-s3-lock.ts` | the signed PUT's headers; `?retention` / `?legal-hold` |
| `driver-s3-copy.ts` | `copy(…, { ifMatch })`: a signed CopyObject |
| `object-lock.ts` | lock types, the `put()` screen, `isLocked`, the local/memory refusals |
| `driver-s3-region.ts` | a provider's wrong-region refusal → `X_CONFIG_INVALID` whose fix names `S3_REGION` |
| `path.ts` | key validation + `META_DIR` + `scopedKey`/`isWithinOrg`/`isTenantScoped` tenant boundary |
| `signed-url.ts` | HMAC over the constraint tuple, constant-time verify |
| `upload.ts` | magic-byte sniff + size/allowlist/checksum policy |
| `iso-bmff.ts` | the `ftyp` MAJOR BRAND → media type (AVIF, HEIC, MOV, M4A, MP4, 3GP) |
| `image.ts` | deterministic variant keys; byte path over core's pipeline (png/jpeg encode only) |
| | `VARIANT_FORMATS` — what a variant KEY can carry — and NOT `IMAGE_FORMATS`, which is core's and means what core can PROBE. See below |
| | `variantKey` is the cache identity `@ultimat3/cli`'s `/media/*` route looks a variant up by — derived, never stored, so a request that misses transforms once and every later one is a disk read |
| `image-variant.ts` | `variant()`: one kept variant, made by an `images` driver PASSED IN (seo's, structurally) |
| `upload-scanner*.ts` / `upload-scan.ts` | the `uploadScanner` port + memory (EICAR) reference; `promoteAttachment` scans a per-attempt copy |
| `image-warm.ts` | `warmVariants`: a stored image's variants written ahead of `/media`, under its keys, the revision off the bytes read; core's spec, so a warmed variant is the one a miss would store |
| `storage.ts` | `defineStorage` + module-level `storage()` / `disk()` |
| `storage-instrument.ts` | each resolved disk: `storage.<verb>` bus event + client span |
| `grant.ts` | `grantUpload` — the ONE way a presigned PUT is minted; the client never names a key |
| `accept.ts` | `acceptSignedUpload` / `readSignedObject` — the two decisions a `/_storage` route is made of |
| `attachment.ts` | `pending/` → row promotion, `sweepOrphans` and `deleteVariants` |
| `errors-sniff.ts` | the two `X_STORAGE_TYPE_REJECTED` refusals only a bounded sniff reaches: too much leading whitespace, XML past the window |
| `upload-client.ts` | the browser half: grant → PUT with progress → key. No `Bun.*`, no `node:` |
| `subject-target.ts` | `storageSubjectTarget(disk, keysOf)` — structural `SubjectTarget`: the app names the keys, export lists, erase deletes |

```bash
bun test                      # from packages/storage
bun run typecheck
```

Gotchas:
- **The local disk refuses a key that is another key's path** (`X_STORAGE_KEY_CONFLICT`, `claim()`);
  pinned, not fixed — changing the layout needs a migration. †
- **The local commit order is marker → sidecar → bytes → clear marker. Do not reorder**; one key's
  writers and `get()` queue in-process (`keyedQueue`), `copy()` holds both keys' turns. †
- **A refused write is `X_STORAGE_PUT_FAILED` and a refused read `X_STORAGE_READ_FAILED`**, on
  local and s3 (both were bare throws); a 404 mid-read stays `X_STORAGE_NOT_FOUND`; `assertPutOptions` holds `metadata`/`cacheControl`/`contentType` to their types on
  all three drivers before a byte moves.
- **`get()` has a ceiling on every disk** (`maxGetBytes`, default `maxPutBytes`), decided on the
  disk's own size before a byte is read. `promoteAttachment` REQUIRES the policy and measures with
  `stat()`, which is a REQUIRED driver method — on s3 it is the first measurement of a direct upload.
- **`lastModified` is optional — absent when the provider sent none**, never epoch 0 and never an
  invalid `Date`. `sweepOrphans` spares an object with no proven age.
- **The base PATH is inside the signature** (`SIGNED_URL_VERSION` `v2`): every local disk shares
  one secret, so the canonical string must name the disk. Path, not origin — the verifying route
  sees a path — and `signedUrlBasePath` is how an absolute `baseUrl` is compared.
- **`isWithinOrg` never throws**: an org id that cannot be one contains nothing.
- **A variant key keeps the whole source key** (`hero.png@w640.webp`): two cache identities.
- **A driver's semantics are `storageDriverConformance`'s** (`@ultimat3/testing/conformance`);
  what only two disks share is pinned in `driver-parity.test.ts`, divergences with their reason. †
- **The local `list()` globs with `dot: true`, and the `META_DIR` skip is the real filter.** †
- **A `list({ limit })` is a positive integer or a refusal** — `resolveListLimit` at the
  `ListOptions` seam, so every disk answers one way. Core's `assert` (`X_INVARIANT`);
  `storageDriverConformance` holds each driver to it.
- **`list()` answers core's `Page<StorageListEntry>`** (`pageOf`); a cursor only when a row past the
  page exists. †
- **`META_DIR` is reserved case-INSENSITIVELY** (`As of 2026-08`), exactly as `isTenantScoped`
  folds: on APFS/NTFS `.META/` IS `.meta/`. The whole SEGMENT is compared, never a prefix
  (`.metadata/a.json` is an ordinary key); `path.test.ts` pins both halves.
- **`disk(name)` resolves through a `Map`, never `config.disks[name]`**: the bracket read walked
  the prototype chain (`disk('constructor')` was the `Object` function, not `X_STORAGE_DISK_UNKNOWN`).
- **`list()` is idempotent for an EMPTY disk and for nothing else** (`As of 2026-08`) — exactly
  `delete()`'s rule. `ENOENT` (a root nobody has written to) is an empty page; everything else is
  `X_STORAGE_LIST_FAILED`, whose `fix` the DRIVER supplies.
- **`head()` and `list()` NEVER read an object's bytes** — an unknowable etag is `''`, as on s3.
  `get()` hashes bytes it holds; `copy()` passes `hash: true`, so no sidecar records `etag: ''`.
- **s3 `put()` with `metadata`/`cacheControl`/`retention`/`legalHold` is ONE signed PUT** (core's
  `signAwsRequest`; Bun's `write` takes no header); a plain `put()` stays on Bun. Reads stay Bun's
  HEAD, so s3 `get()` reports neither field — pinned in `driver-parity.test.ts`.
- **Object Lock: local/memory REFUSE delete/overwrite/copy-onto** (`X_STORAGE_OBJECT_LOCKED`);
  S3 accepts both (delete marker, new version; the locked version stays). Pinned divergence: one
  version per key. A pair in doubt never unlocks. `NoSuchObjectLockConfiguration` is a 404.
- **A live suite signs on a wall clock** (`performance`): `Date` is frozen → `RequestTimeTooSkewed`.
- **A grant binds its size on every disk**: s3 signs `content-length` (`presignAwsUrl`), local/memory
  hold `x-max`; `maxBytes` with no `contentLength` on s3 is `X_STORAGE_UPLOAD_SIZE_UNDECLARED`. †
- **`putStream` on s3 is signed multipart, never `S3File.writer()`** (Bun 1.4.4: `end(error)` COMPLETES). 8 MiB parts, ≤ `STREAM_PART_BUFFERS` held; parts settle before the abort; a Complete can fail with 200 + `<Error>`.
- **s3 `copy()` is a signed CopyObject**, past 5 GiB `UploadPartCopy`: Bun's `write(S3File)` dropped `cacheControl`/metadata.
- **`stream(key, { etag })` never serves another revision**: local re-checks the etag at the first pull, never the inode (ext4 reuses it; `highWaterMark: 0`: an unread body holds no fd); s3 sends `If-Match`.
- **The upload route streams** (`accept-stream.ts`). Keys refuse `:`, a trailing `.`, Win32 device names; `contentType`/`cacheControl` are `HEADER_VALUE` on every disk.
- **`promoteAttachment` sniffs a head window** (`validateStoredHead`, 64 KiB), then ties it to the
  copy: `ifMatch`, then size and etag. Never refuse on etag alone: SSE-KMS mints one per copy.
- **`/media`'s variant key names its source's revision and format.** No `revision`: the old key.
- **`delete()` is idempotent for an ABSENT key and for nothing else** — a swallowed refusal made
  `sweepOrphans` certify an erasure that never happened. s3 classifies structurally (`NoSuchKey`/
  `NotFound`/`ENOENT` or a 404), local on `ENOENT`; else `X_STORAGE_DELETE_FAILED`, fix per driver.
- **`toBytes` takes a `ByteLimit`, and there is no unbounded variant**; one default,
  `DEFAULT_MAX_UPLOAD_BYTES` (`upload.ts`). †
- **`serverSideEncryption` is declared and refused by BOTH drivers.** Full rule: `docs/history/storage.md`.
- **The `uploadScanner` port is the ONE scan path** (`As of 31.0.0`; the `quarantine: true` segment
  and `releaseQuarantine` are retired). An out-of-band decision — a review, an async vendor scan —
  is the verdict `hold`, keyed by `(ScanInput.pendingKey, ScanInput.revision)` — the etag, or the bytes' sha256 (31.3; `pendingKey` alone cleared a rewrite): `X_STORAGE_QUARANTINED` (409), upload
  kept pending, attempt deleted, no policy overrides it. A scanner that holds declares `holds: true`
  (else its `hold` is `X_INVARIANT`), and its outage then refuses even under `'accept'`. A targeted
  grant is refused while a scanner is installed (`X_STORAGE_TARGET_UNSCANNED`): it skips promotion.
  Ultimate ships no scanner vendor (axiom 8).
  **No verdict fails closed in every environment** (`onScanUnavailable` absent = `'refuse'`).
- **`StorageListEntry` vs `StorageObject`.** A listing's `contentType` is optional; a `get()`'s is
  not. `ListObjectsV2` returns no Content-Type, and no driver invents one.
- **`META_DIR` lives in `path.ts`, reserved in `assertSafeKey` on every driver** — the sidecar
  namespace must never be a writable key. †
- **`localDriver` refuses to construct outside development without a usable signing secret** (`X_ENV_MISSING`, borrowed from core). Full rule: `docs/history/storage.md`.
- **`localDriver({ env })` and `usesDevStorageSecret({ env })` are ONE question about ONE table**:
  the secret, `isLocal()` and the refusal's environment all read `options.env ?? process.env`, so
  the boot's guard and the constructor it guards cannot answer from two tables.
  `driver-local-boot.test.ts` pins it by mutation.
- **The mounted read half is `@ultimat3/cli`'s `runtime-storage.ts`**, gated by policy; no
  "serve this object" helper here (a second authz path). †
- `acceptSignedUpload` still has no mounted route: no `StorageDriver` method exposes the signing
  secret. †
- `X_NOT_IMPLEMENTED` is core's — it belongs in `STORAGE_BORROWED_ERROR_CODES` (codes, no title)
  and never in the registration call. A `hasErrorCode()` guard there would suppress the
  `X_ERROR_CODE_DUPLICATE` two owners of one code are supposed to get. Tests need `resetStorage()`
  in `beforeEach`.
- `image.ts` owns no pixels: core's `transformImageBytes` is the only scaler; image failures surface
  unwrapped. †
- **`VARIANT_FORMATS` is this package's format vocabulary, and `IMAGE_FORMATS` is core's.** †
- `transformImage()` encodes at exactly `fitDimensions()`'s size, `format` explicit — anything else
  is a layout shift. †
- Bun's S3 flag is `virtualHostedStyle`; our `forcePathStyle` is its inverse.
- **No `region` signs for `auto`** (R2's; AWS refuses it) — `regionMismatch()` makes it `X_CONFIG_INVALID` naming `S3_REGION`. Full rule: `docs/history/storage.md`.
- The signature check runs BEFORE the expiry check. Do not reorder.
- `timingSafeEqual` is `@ultimat3/core`'s (`signed-url.ts` imports it) — the same
  implementation `@ultimat3/auth` uses, not a second copy. Add new secret comparisons through it.
- `verifySignedUrl` never throws, and `parseConstraints` is where that is kept: the key is decoded
  through the guarded `decodeSegment`, so a `%ZZ` in the path is `'malformed'` rather than the bare
  `URIError` `decodeURIComponent` raises. Same shape as `@ultimat3/core`'s `readCookie`.
- `acceptSignedUpload` refuses a URL signed with **no** content type (`unconstrained`). `grantUpload`
  always sets one, so such a URL is hand-rolled, and trusting the uploader's header instead is the
  only other option.
- **The signed base is the disk's REGISTERED name, and it is stated once — on the driver.** Full rule: `docs/history/storage.md`.
- **`accept.ts` asks the `isTenantScoped`/`isWithinOrg` PAIR, as `runtime-storage.ts` does.** Do not
  "simplify" either half. †
- **`AcceptSignedUploadInput.checksum` is what makes `requireChecksum: true` reachable**; the browser
  half sends none. †
- `orgId` is required on both halves of `accept.ts` and is the ACTOR's, never a request field. A
  signed URL is a capability; a leaked capability must still not cross a tenant.
- `X_STORAGE_ORG_MISMATCH` maps to **404**, not 403 (`@ultimat3/http`'s `error-map.ts`). 403 would
  confirm a key exists to the one caller who must not learn it.
- **Local `lastModified` is the `Clock`'s, kept in the sidecar** — one instant from `put`/`copy`
  to every read; mtime only with no trusted sidecar.
- `upload-client.ts` uses `XMLHttpRequest` for upload progress — the framework's one declared XHR
  seam. †
- **`fetchSignedPut` goes through `@ultimat3/core`'s `clientTransport`**; it calls no `fetch`. †
- **Bundle** (`uploadFile` only, browser, minified, `As of 2026-09-22`): **17,767 B**.
- `exactOptionalPropertyTypes` is on — declare optional fields as `x?: T | undefined`.

Why each rule above is shaped the way it is: [`docs/history/storage.md`](../../docs/history/storage.md).
