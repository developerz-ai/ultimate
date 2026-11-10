# storage: rule text moved out of `packages/storage/CLAUDE.md`

`As of 2026-11-10`. Plan 101 wave G cut the package file toward a 20 KB working target (the
enforced ceiling is 24,576 B, `bun run scripts/claude-md-size.ts`). Each section below is a bullet
as it stood, verbatim; the package file keeps a one-line rule marked `†`. Where the two disagree,
`packages/storage/CLAUDE.md` wins. The older long form is [`storage.md`](storage.md).

## Key-is-another-key's-path conflict

- **The local disk refuses a key that is another key's path, and that is pinned, not fixed**
  (`As of 2026-10`). `put('a')` then `put('a/b')` — or the reverse, or `a` beside `a.json/b` in the
  sidecar tree — is `X_STORAGE_KEY_CONFLICT`, decided by `claim()` for BOTH paths before either is
  touched. Suffixed on-disk names would lift it and orphan every existing root's objects without a
  migration; do not change the layout without one. Memory emulates it; s3 holds both. A key that
  is only a directory is ABSENT to `delete()` (test a refusal with `driver-local-fixture.ts`).

## Local commit order

- **The local commit order is marker → sidecar → bytes → clear marker. Do not reorder**
  (`As of 2026-10`). Bytes-first serves new bytes under the old type; sidecar-first alone serves
  old bytes under the new one. The marker holds the new etag, so `headObject` knows the one state
  in which the sidecar may not describe the bytes: `get`/`stat`/`copy` re-check against the bytes,
  `list` reports no type and `etag: ''`. A fresh key is absent until its bytes land.
  `driver-local-crash.test.ts` dies at every step through `WriteSteps`. Writers and `get()` of one
  key also queue in-process (`keyedQueue`) — unqueued, two puts interleaved 3/3. `copy()` holds BOTH
  keys' turns (`inTurnOfBoth`, key order): measured in one and read in the other, an overwritten
  source committed new bytes under the old etag.

## Driver semantics and parity

- **A driver's semantics are `storageDriverConformance`'s** (`@ultimat3/testing/conformance`, run
  over memory, local and s3); what only two disks share is pinned beside each other —
  `driver-parity.test.ts` drives `localDriver` over a temp dir and `s3Driver` over `FakeS3Client`
  in a single `test()` per claim, so neither disk can move alone. Where the two genuinely cannot
  agree it pins the DIVERGENCE, with the reason — that is the honest form, and it still fails the
  day either half changes.

## Local `list()` and dot keys

- **The local `list()` globs with `dot: true`, and the `META_DIR` skip is the real filter.**
  Without `dot`, dot-prefixed keys were missing from the listing while `put`/`get` handled them —
  and `sweepOrphans` pages through `list()`. Pinned on every disk by `@ultimat3/testing/conformance`'s
  `storageDriverConformance`.

## `list()` pages

- **`list()` answers core's `Page<StorageListEntry>`, and no storage-local page type exists**
  (`As of 25.0.0`; `ListPage` is deleted). Every driver builds it with core's `pageOf`, so
  `hasMore` is derived from the cursor and cannot disagree with it. The cursor is minted only when
  a row past the page exists — never from `rows.length === limit`, the full-last-page defect a
  query's cursor had — and the full-last-page case is pinned on memory, local and live s3.

## A grant binds its size

- **A grant binds its size on every disk** (`As of 2026-11-02`). `grantUpload` requires `request.size` and passes `contentLength`; `s3Driver` signs `content-length` through core's `presignAwsUrl`, because Bun's presign signs `host` alone, so any other length is a 403 (`driver-s3.live.test.ts`). Local and memory hold it as the `x-max` ceiling, so a shorter body passes there: `driver-parity.test.ts` pins it. `maxBytes` with no `contentLength` on s3 is `X_STORAGE_UPLOAD_SIZE_UNDECLARED`. The content type stays unsigned.

## `toBytes` is bounded

- **`toBytes` takes a `ByteLimit`, and there is no unbounded variant.** `put()` buffers, so the
  ceiling is what keeps a route piping a 4GB body into `disk.put()` from being an OOM kill rather
  than a refusal. `Uint8Array`/`Blob` are refused on their declared length; a `ReadableStream` is
  read chunk-by-chunk and **cancelled** past the line, so at most one chunk over is ever held.
  Default `maxPutBytes` is `DEFAULT_MAX_UPLOAD_BYTES` — one constant, imported by both drivers
  from `upload.ts`, because the server-side ceiling and the upload ceiling are the same fact.

## `META_DIR` lives in `path.ts`

- **`META_DIR` lives in `path.ts`, not in `driver-local.ts`.** The sidecar namespace overlapped the
  object namespace: `put('a/b', png)` writes `<root>/.meta/a/b.json`, and `.meta/a/b.json` was
  itself a legal key, so an uploader could rewrite another object's recorded `contentType` to
  `text/html` and have a route serve attacker HTML from the app's origin. Reserved in
  `assertSafeKey`, so it holds for S3 too — a key valid on one driver and refused on another is two
  key rules, and the reservation folds case — see above. The `list()` skip is not a second line of
  defence but the only one: the glob yields the sidecar tree.

## The mounted read half

- **The mounted read half is `@ultimat3/cli`'s `runtime-storage.ts`, not this package.** `GET
  /_storage/:disk/*key` gates on `@ultimat3/policy`'s `evaluate()` (`storage:read`), which is tier
  2 and unreachable from here — so a "serve this object" helper in this package could only ever be
  a second authz path. This package's contribution to that route is `assertSafeKey`,
  `isTenantScoped`/`isWithinOrg` and the driver's own `contentType`/`etag`; the `Response` is
  `@ultimat3/http`'s `objectResponse`, structural over those fields, as `accept.ts`'s header says.

## `acceptSignedUpload` has no mounted route

- `acceptSignedUpload` still has no mounted route: the signing secret is closed over inside
  `localDriver` and no `StorageDriver` method exposes it, so a host cannot verify a signed PUT
  through the `Storage` seam it is handed. Serving reads needed none of it (policy decides, not a
  signature); mounting the write half needs that seam question answered first.

## `transformImage()` dimensions

- `transformImage()` must encode at exactly `fitDimensions()`'s size, and passes `format`
  explicitly (`?? 'webp'`, which then rejects): bytes that disagree with the `variantKey`
  extension, or with the `width`/`height` `@ultimat3/seo` inlined, are the layout shift the
  whole path exists to prevent. That is why it derives the box itself and asks core for
  `fit: 'cover'` — core's `contain` letterboxes to the requested box, this API fits inside it.

## `accept.ts` tenant pair

- **`accept.ts` asks the `isTenantScoped`/`isWithinOrg` PAIR, exactly as `runtime-storage.ts` does.**
  `isWithinOrg` alone refused every un-scoped key, so an app's own `brand/logo.png` was unreachable
  through a URL it had just signed. `isTenantScoped` is case-INSENSITIVE and `isWithinOrg` is not:
  `Org/o2/x` and `org/o2/x` are one file on APFS/NTFS, so the fold has to count as tenant-scoped
  and then fail the exact-case membership test. Do not "simplify" either half.

## `AcceptSignedUploadInput.checksum`

- **`AcceptSignedUploadInput.checksum` is what makes `uploadPolicy({ requireChecksum: true })`
  reachable.** Without it that option could only ever fail, because nothing on the accept path
  could declare a hash. It travels like `declaredContentType`: the route reads a header and hands
  it over, and `validateUpload` hashes the bytes itself. The browser half does NOT send one — a
  custom header on an S3 presigned PUT is a signature question this package cannot answer.

## `upload-client.ts` and XHR

- `upload-client.ts` defaults to `XMLHttpRequest`, not `fetch`: `fetch` reports no upload
  progress in any shipping browser, and a bar that jumps 0 → 100 is a bar that is lying. It is
  **the declared XHR seam** of plan 101 (decision 13): the one `XMLHttpRequest` the framework
  ships, and the one file slice 15's `browser-transport` guard exempts for it — the header says so.

## `fetchSignedPut`

- **`fetchSignedPut` goes through `@ultimat3/core`'s `clientTransport`** (`As of 2026-09-22`,
  plan 101 slice 05): `rawBody` sends the `Blob` verbatim under the grant's content type with no
  default header, and `decodeError` keeps a refusal `X_STORAGE_UPLOAD_FAILED` with the disk's
  status. A request with no response at all is the transport's `X_CLIENT_TRANSPORT_FAILED` — it was a
  bare `TypeError` before. This file calls no `fetch`; the XHR above is the one exemption.

## `image.ts` owns no pixels

- `image.ts` owns no pixels: core's `transformImageBytes`/`blurDataUrl` are the only scaler.
  Its image failures (`X_IMAGE_UNSUPPORTED`, `X_IMAGE_DECODE_FAILED`) surface unwrapped —
  wrapping them in a `StorageError` would give one failure two codes. `variantKey` now RAISES
  core's `imageUnsupported()` as well as passing them through, for that same reason.

## `VARIANT_FORMATS` vs `IMAGE_FORMATS`

- **`VARIANT_FORMATS` is this package's format vocabulary, and `IMAGE_FORMATS` is core's** (what
  core can PROBE). `as const satisfies readonly ImageFormat[]` makes it a strict subset by the
  compiler; `isVariantFormat` takes `string` so `probeImage(bytes).format` narrows with no cast.
  `scripts/render-modes.ts` holds the `IMAGE_FORMATS` row and `image.test.ts` fails if either core
  name reappears in `src/index.ts`.
