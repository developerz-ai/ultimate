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

- **Every byte ceiling and every TTL is screened where it is DECLARED, `As of 2026-08-26`** —
  `uploadPolicy({ maxBytes })`, both drivers' `maxPutBytes`, `createUploadGrant({ expiresInMs })`
  and `buildSignedUrl`'s two, through core's `finiteCount` or `assertFiniteSignedUrlBound`.
  Measured: `uploadPolicy({ maxBytes: Number.NaN })` accepted a 5,000,016-byte PNG through
  `validateUpload`, because `size > NaN` is false — the one number deciding how much a caller may
  store stopped deciding anything. Variant `quality` is core's `assertFiniteImageQuality` and NOT a
  second screen: `variantKey` never reaches the encoder, so a copy that disagreed would mint
  `q150` keys for bytes `transformImageBytes` then refuses.

- **`MAX_KEY_LENGTH` is BYTES, and is measured in bytes, `As of 2026-08-26`.** S3's limit is "a
  sequence of Unicode characters whose UTF-8 encoding is at most 1,024 bytes long", and `path.ts`
  measured `key.length` — UTF-16 code units — while its message said "chars". A code-unit count is
  never MORE than the UTF-8 byte count, so a non-ASCII key over the real limit passed this guard
  and was refused by the store instead: 400 CJK characters is 400 units and 1,200 bytes. Keeping
  local and remote disks interchangeable is the whole reason the ceiling exists, so it has to be
  the store's ceiling. Same defect and same fix as `@ultimat3/cache`'s surrogate-key guard.

| Rule | |
|---|---|
| Errors | `StorageError` + one factory per code in `errors.ts`; never `throw new Error` |
| New code | add to `STORAGE_ERROR_CODES` **and** `STORAGE_ERROR_TITLES` |
| Keys | every driver method starts with `assertSafeKey()`. No exceptions, no sanitising. `META_DIR` (`.meta`) is a reserved first segment on every driver — see below |
| Time | take a `Clock`; never `Date.now()` |
| Bytes | `Uint8Array \| ReadableStream \| Blob`. Never a base64 string, never unbounded — `toBytes(body, limit)` |
| Exports | explicit in `src/index.ts`; no `export *` |

| File | Owns |
|---|---|
| `driver.ts` | `StorageDriver` contract (8 methods) + bounded `toBytes`/`sha256Base64`/`etagOf` |
| `driver-local.ts` | dev default over `Bun.file`, `.meta/` sidecars, `Bun.Glob` listing |
| `driver-s3.ts` | `Bun.S3Client`, built lazily (import must never open a socket) |
| `path.ts` | key validation + `META_DIR` + `scopedKey`/`isWithinOrg`/`isTenantScoped` tenant boundary |
| `signed-url.ts` | HMAC over the constraint tuple, constant-time verify |
| `upload.ts` | magic-byte sniff + size/allowlist/checksum policy |
| `image.ts` | deterministic variant keys; byte path over core's pipeline (png/jpeg encode only) |
| | `VARIANT_FORMATS` — what a variant KEY can carry — and NOT `IMAGE_FORMATS`, which is core's and means what core can PROBE. See below |
| | `variantKey` is the cache identity `@ultimat3/cli`'s `/media/*` route looks a variant up by — derived, never stored, so a request that misses transforms once and every later one is a disk read |
| `storage.ts` | `defineStorage` + module-level `storage()` / `disk()` |
| `grant.ts` | `grantUpload` — the ONE way a presigned PUT is minted; the client never names a key |
| `accept.ts` | `acceptSignedUpload` / `readSignedObject` — the two decisions a `/_storage` route is made of |
| `attachment.ts` | `pending/` → row promotion, the `quarantine/` segment, and `sweepOrphans` |
| `upload-client.ts` | the browser half: grant → PUT with progress → key. No `Bun.*`, no `node:` |

```bash
bun test                      # from packages/storage
bun run typecheck
```

Gotchas:
- **A driver's semantics are pinned in ONE test with the other driver beside them.**
  `driver-parity.test.ts` drives `localDriver` over a temp dir and `s3Driver` over `FakeS3Client`
  in a single `test()` per claim, so neither disk can move alone. Where the two genuinely cannot
  agree it pins the DIVERGENCE, with the reason — that is the honest form, and it still fails the
  day either half changes.
- **The local `list()` globs with `dot: true`, and the `META_DIR` skip is the REAL filter**
  (`As of 2026-08`). `Bun.Glob('**/*')` matches no dot-prefixed entry, so every object whose key
  had one — `.hidden.txt`, `org/o1/pending/.x.png`, the `.metadata/a.json` `path.test.ts` pins as
  legal — was missing from the listing while `put`/`get`/`exists` handled it normally and
  `s3Driver.list()` returned it: the key space and the listing disagreed by construction.
  `sweepOrphans` pages through `list()`, so those objects were reported as erased while still on
  disk — a false erasure report by OMISSION, the same lie a swallowed listing error tells. The
  `.meta/` skip one line below was unreachable until this landed and this file called it "a second
  line of defence"; it is now the only thing keeping the sidecar tree out of the object namespace,
  and it folds case for `isSafeKey`'s reason. Pinned in `driver-parity.test.ts`.
- **A `list({ limit })` is a positive integer or a refusal** — `resolveListLimit` at the
  `ListOptions` seam, so both disks answer one way. `limit: 0` used to slice `[0, 0)` on the local
  disk and then drop its own `truncated` flag (`truncated && last !== undefined`, with an empty
  page), so a paging caller read "complete, and there is nothing here" over a full disk, while the
  s3 disk handed `maxKeys: 0` to the provider. Core's `assert` (`X_INVARIANT`), for the reason
  `@ultimat3/seo`'s `chunk()` uses it: a bound with no code of its own is still a coded refusal.
- **`META_DIR` is reserved case-INSENSITIVELY** (`As of 2026-08`), exactly as `isTenantScoped`
  folds and for the same filesystem: `.META/a.txt.json` was a legal key that writes
  `<root>/.META/a.txt.json`, which on APFS and NTFS IS `<root>/.meta/a.txt.json` — the sidecar for
  object `a.txt` — so a caller able to name a key rewrote another object's recorded `contentType`.
  The whole SEGMENT is compared, never a prefix: `.metadata/a.json` is an ordinary key and stays
  one, and `path.test.ts` pins both halves.
- **`disk(name)` resolves through a `Map`, never `config.disks[name]`.** The bracket read walked
  the prototype chain, so `disk('constructor')` handed back the `Object` function and the next
  `.put()` was a bare `TypeError` — `X_STORAGE_DISK_UNKNOWN` unreachable for `constructor`,
  `toString`, `valueOf`, `hasOwnProperty` and `__proto__`, in a function whose own
  `default:` check already read `Object.keys`.
- **`list()` is idempotent for an EMPTY disk and for nothing else** (`As of 2026-08`) — exactly
  `delete()`'s rule, one call to the left, and both drivers broke it in opposite directions. The
  local one caught EVERYTHING and answered `{ objects: [], truncated: false }`, so `EACCES` on the
  root read as "this disk is empty"; the s3 one let a bare `S3Error` escape uncoded, with nothing
  for the http error map to render but a 500. `sweepOrphans` walks `list()`, so the local swallow
  was a false-erasure report a layer up. `ENOENT` (a root nobody has written to) is still an empty
  page; everything else is `X_STORAGE_LIST_FAILED`, whose `fix` the DRIVER supplies.
- **`head()` NEVER reads an object's bytes, and `list()` is why** (`As of 2026-08`). It hashed a
  sidecar-less object to invent an etag, under a comment saying "`list()` must not read every file
  it lists" — which is what `list()` then did, one whole buffered object per listed row,
  sequentially, and `copy()` inherited it, so a copy documented as never routing bytes through the
  heap buffered the entire source. A listing that cannot know an etag reports `''`, which is what
  the s3 listing already answers. `get()` hashes out of bytes it already holds; `copy()` passes
  `hash: true`, because the sidecar it writes at the destination would otherwise carry `etag: ''`
  as a durable lie.
- **`put({ metadata })` / `put({ cacheControl })` is the one `PutOptions` pair the disks disagree
  about, and it is pinned rather than resolved.** Bun's `S3File.write` exposes `type`, `acl` and
  `storageClass` and no header hook for `x-amz-meta-*` or `Cache-Control`, so `s3Driver` refuses
  (`X_NOT_IMPLEMENTED`, with the out-of-band `aws s3 cp` in the fix) while `localDriver` stores both
  in its sidecar and reads them back. **Do not "fix" this by making the local disk refuse too** —
  that deletes a working capability and the two `StorageListEntry` fields that carry it, to buy
  symmetry with a limitation that is Bun's and temporary. The day the hook lands, the s3 half of
  `driver-parity.test.ts` fails and the resolution is to make s3 store them.
- **`signedUrl({ maxBytes })` is signed on `local` and unenforceable on `s3`, and the s3 driver may
  NOT refuse it.** `grantUpload` passes `maxBytes: policy.maxBytes` on every grant, so a refusal
  would break every s3 upload an app mints. S3 has no request header for a size and Bun's `presign`
  covers method, expiry and type — so on the production disk the client PUTs straight into the
  bucket and nothing between the grant and the object holds the ceiling. That belongs to a bucket
  rule or a post-upload `object.size` check, neither of which is a driver's; `SignedUrlOptions`
  says so and `driver-parity.test.ts` pins both halves.
- **`delete()` is idempotent for an ABSENT key and for nothing else.** Both drivers used to end in
  `.catch(() => undefined)`, so a denied `s3:DeleteObject`, a `SlowDown`, an expired credential and
  a read-only mount all resolved as success — and `sweepOrphans` returned them as deleted, which
  is a GDPR erasure report certifying data that is still in the bucket. The s3 driver classifies
  structurally (`code` in `NoSuchKey`/`NotFound`/`ENOENT`, or a 404 `statusCode`/`status`; an
  `S3Error` is a plain `Error` with those fields and every read of one can throw), the local
  driver on `ENOENT`. Everything else is `X_STORAGE_DELETE_FAILED`, whose `fix` the DRIVER
  supplies — the command that reproduces the refusal differs per disk.
- **`toBytes` takes a `ByteLimit`, and there is no unbounded variant.** `put()` buffers, so the
  ceiling is what keeps a route piping a 4GB body into `disk.put()` from being an OOM kill rather
  than a refusal. `Uint8Array`/`Blob` are refused on their declared length; a `ReadableStream` is
  read chunk-by-chunk and **cancelled** past the line, so at most one chunk over is ever held.
  Default `maxPutBytes` is `DEFAULT_MAX_UPLOAD_BYTES` — one constant, imported by both drivers
  from `upload.ts`, because the server-side ceiling and the upload ceiling are the same fact.
- **`serverSideEncryption` is declared and refused by BOTH drivers.** Bun exposes `acl`,
  `storageClass` and `type` and nothing for `x-amz-server-side-encryption*`, and a POSIX file is
  not encrypted at all. Refusing on the dev disk too is deliberate: a `put()` that works in `x dev`
  and throws in production is two rules. Lifecycle, storage classes and replication stay out
  entirely — bucket-side, terraform's, axiom 7.
- **Quarantine is `pending/quarantine/`, INSIDE the pending prefix.** So `sweepOrphans` collects a
  never-scanned upload with no second prefix to walk, and `isPendingKey` stays true for it.
  `promoteAttachment` refuses a quarantined key (`X_STORAGE_QUARANTINED`); `releaseQuarantine` is
  the app's scan verdict, and returns the ordinary pending key promotion accepts. Ultimate ships
  no scanner — axiom 8, and `application/zip` is an accepted OOXML container by design.
- **`StorageListEntry` vs `StorageObject`.** A listing's `contentType` is optional; a `get()`'s is
  not. `ListObjectsV2` returns no Content-Type, and the s3 driver used to invent
  `application/octet-stream` while the local driver read the truth from its sidecar — two drivers
  disagreeing about one object. The local `list()` now omits it too when there is no sidecar.
- **`META_DIR` lives in `path.ts`, not in `driver-local.ts`.** The sidecar namespace overlapped the
  object namespace: `put('a/b', png)` writes `<root>/.meta/a/b.json`, and `.meta/a/b.json` was
  itself a legal key, so an uploader could rewrite another object's recorded `contentType` to
  `text/html` and have a route serve attacker HTML from the app's origin. Reserved in
  `assertSafeKey`, so it holds for S3 too — a key valid on one driver and refused on another is two
  key rules, and the reservation folds case — see above. The `list()` skip is not a second line of
  defence but the only one: the glob yields the sidecar tree.
- **`localDriver` refuses to construct outside development without a usable signing secret**
  (`X_ENV_MISSING`, borrowed from core). Usable means neither the `signingSecret` option nor
  `STORAGE_SIGNING_SECRET` is missing, empty **or** the published `DEV_SIGNING_SECRET` — pasting
  the literal into `app.config.ts` configures nothing, so it is refused exactly as its absence is.
  `DEV_SIGNING_SECRET` is published in this repo, and `acceptSignedUpload` trusts a signed URL's
  constraints over the app's `uploadPolicy` — so the fallback is a universal grant to mint any
  `PUT`. Refused at construction, not at the first `signedUrl()`: a process that cannot sign safely
  must not finish booting. The cause names the environment `resolveEnvironment()` resolved, which
  may be `NODE_ENV`'s, never a variable the process did not set. `usesDevStorageSecret()` is the
  `x doctor` predicate, mirroring core's `usesDevCursorSecret()`; it reads the env var, so a disk
  handed an explicit `signingSecret` is outside its question.
- **`localDriver({ env })` and `usesDevStorageSecret({ env })` are ONE question about ONE table**
  (`As of 2026-08-23`). The predicate learned core's `env` slot first, so `dev-runtime.ts`'s guard
  — `!isLocal({ env }) && usesDevStorageSecret({ env })` — asked about the BOOT while the
  constructor it guards still read `process.env` for the secret, for `isLocal()` and for the
  environment its refusal names. An embedding caller whose env is not the process's (`serveApp({ env })`,
  a test fixture) got the verdict from one table and the behaviour from another, in the dangerous
  direction: a production boot with no secret, launched from a development shell that has one,
  signing every grant with the published literal. All three reads now come off `options.env ??
  process.env`, so a bare `localDriver({ root })` is unchanged and additive.
  `driver-local-boot.test.ts` pins it by mutation — reverting any one read to `process.env` fails.
  That file is the CONSTRUCTION half, split off `driver-local.test.ts` at the line ceiling along
  the seam the guard already draws: nothing in it writes a byte, so it needs no temporary
  directory, and `driver-local.test.ts` keeps everything the disk actually does with an object.
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
  wrapping them in a `StorageError` would give one failure two codes. `variantKey` now RAISES
  core's `imageUnsupported()` as well as passing them through, for that same reason.
- **`VARIANT_FORMATS` is this package's format vocabulary, and `IMAGE_FORMATS` is core's.** Until
  9.0.0 both packages exported `IMAGE_FORMATS` **and** `ImageFormat` from their own barrels over
  different sets (core: `png|jpeg|webp|avif|gif|svg`, what it can PROBE; storage: `avif|webp|jpeg|png`),
  so a caller narrowing on storage's held a type saying `gif` and `svg` could not occur and a
  `probeImage()` value that was one — and `variantKey('photos/hero.gif', { format })` minted
  `photos/hero@full.undefined`, a well-formed writable key naming a file nothing can serve. The set
  is now a strict subset **by the compiler**: `as const satisfies readonly ImageFormat[]`, so a
  member core cannot name is a build error here. `isVariantFormat` takes `string` on purpose, so
  `probeImage(bytes).format` narrows through it with no cast. `avif` is in the set and `gif`/`svg`
  are not because the question is what a variant KEY can carry, never what core can transform —
  core decodes `gif` perfectly well, and naming this set `TRANSFORMABLE_FORMATS` would have been
  the same lie one rename later. `scripts/render-modes.ts` holds the `IMAGE_FORMATS` row (`by:
  'name'`) and `image.test.ts` fails the day either core name reappears in `src/index.ts`.
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
- **The signed base is the disk's REGISTERED name, and it is stated once — on the driver.**
  `defineStorage` tells each driver its registration key (`StorageDriver.registerAs`), the driver
  rebases its URLs onto `signedUrlBaseFor(diskName)`, and `accept.ts` reads `disk.signedUrlBase`
  rather than deriving a second one. Both halves used to derive it from `disk.name` — the DRIVER
  kind — so they agreed with each other and disagreed with the mounted `/_storage/:disk/*key`
  route, which resolves the segment through the registry: a disk registered as `uploads` minted
  `/_storage/local/...` and 404'd its own signatures. Latent only because every disk in this repo
  happens to be named `local`. An explicit `baseUrl` on `localDriver` outranks the registration
  (the operator saying where the route is mounted); an unregistered driver still mints under
  `local`. One driver instance under two disk names is refused at `defineStorage`
  (`X_CONFIG_INVALID`) — it could only mint under one of them. Before that, the base was stated
  twice (`/_storage/local` in the driver, `/_storage` in `verifySignedUrl`'s default) and NO
  genuine URL verified at all: the key parsed as `local/<key>`. `@ultimat3/cli`'s
  `STORAGE_BASE_PATH` is a third statement of the mount prefix and should import
  `DEFAULT_SIGNED_URL_BASE` instead.
- **`accept.ts` asks the `isTenantScoped`/`isWithinOrg` PAIR, exactly as `dev-storage.ts` does.**
  `isWithinOrg` alone refused every un-scoped key, so an app's own `brand/logo.png` was unreachable
  through a URL it had just signed. `isTenantScoped` is case-INSENSITIVE and `isWithinOrg` is not:
  `Org/o2/x` and `org/o2/x` are one file on APFS/NTFS, so the fold has to count as tenant-scoped
  and then fail the exact-case membership test. Do not "simplify" either half.
- **`AcceptSignedUploadInput.checksum` is what makes `uploadPolicy({ requireChecksum: true })`
  reachable.** Without it that option could only ever fail, because nothing on the accept path
  could declare a hash. It travels like `declaredContentType`: the route reads a header and hands
  it over, and `validateUpload` hashes the bytes itself. The browser half does NOT send one — a
  custom header on an S3 presigned PUT is a signature question this package cannot answer.
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
