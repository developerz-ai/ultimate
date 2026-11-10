# Storage and uploads

**Call sites name a disk, never a driver.** Package `@ultimat3/storage` (tier 1) — the full
reference is
[`packages/storage/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/storage/README.md),
and the upload design is
[`docs/architecture/17-uploads.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/17-uploads.md).

```ts
import { defineStorage, disk, localDriver, s3Driver, scopedKey } from '@ultimat3/storage';

defineStorage({
  disks: {
    uploads: localDriver({ root: '.storage/uploads' }),
    media: s3Driver({ bucket: 'media', endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }),
  },
  default: 'uploads',
});

await disk('media').put(scopedKey(orgId, 'avatars', 'a.png'), bytes, { contentType: 'image/png' });
```

Swapping `local` for `s3` changes no call site, and `x dev` needs no S3 server.

| Driver | Backing | For |
|---|---|---|
| `localDriver` | `Bun.file` under one root; writes are staged and renamed in an order whose every crash point reads as absent, whole or untyped — never a wrong content type | dev, tests, a single node. A key cannot be a path prefix of another (`a` and `a/b`): the second is `X_STORAGE_KEY_CONFLICT`. `s3Driver` and `memoryStorageDriver` hold both |
| `s3Driver` | `Bun.s3` | any S3-compatible endpoint — AWS, R2, a self-hosted gateway. The difference is `endpoint`, `region` and `forcePathStyle`. Credentials are env var **names**, never literals |
| `memoryStorageDriver` | a `Map` in this process | a test's disk: `defineStorage({ disks: { uploads: memoryStorageDriver() } })`. Every method `localDriver` answers, the same refusals, the same signing rule; `objects()` is a copy of the stored bytes by key. Never a deployment's disk — a restart is every object gone |

A driver of your own is the `storage` adapter port: `StorageDriver` from `@ultimat3/storage/adapter`, `memoryStorageDriver` to copy, `behavesLike(storageDriverConformance, () => yourDriver())` to prove it — [Adapters](Adapters#storage). It is used in `defineStorage({ disks })`, or as `storage:` in `apps/<app>/runtime.ts` for the boot's one default disk.

**A declaration holds a disk by THUNK, never by value.** `disk('sessions')` resolves through
`defineStorage()`, which boot runs after an app's modules were evaluated — so a `scrape()` or any
other declaration built at import time takes `() => disk('sessions')` and reads it when it is
used ([Scraping](Scraping)). Called at module scope, `disk()` is `X_CONFIG_INVALID`: storage was
not defined yet.

A real S3 on a laptop is `docker/docker-compose.dev.yml`'s `s3` service — Versity S3 Gateway over a
volume, with the bucket already there (a directory under its root is a bucket, and the volume is
mounted at one). Point the app at it with `S3_ENDPOINT=http://127.0.0.1:9000`, `S3_BUCKET=<app>`,
`S3_FORCE_PATH_STYLE=1` and the key pair the file ships. That file chooses a server for development
only — production is whichever S3-compatible endpoint you run.

`S3_FORCE_PATH_STYLE` is `1` (on) or `0` (off); unset or blank is off. Anything else refuses the boot
with `X_CONFIG_INVALID`, because `true` used to read as off and send every request to `<bucket>.<host>`.

`S3_REGION` is the region requests are signed for. Unset, they are signed for `auto`: what R2 wants
and what the dev gateway is started with. An endpoint that expects another region refuses the
first write, list or delete with `X_CONFIG_INVALID`, and the fix line names the value to set.

## A listing is the framework's one page

`disk(name).list({ prefix, cursor, limit })` answers `Page<StorageListEntry>` — `{ rows,
nextCursor, hasMore }`, the shape `findMany` and a query's `.page()` answer. `nextCursor` is a
string exactly when another object exists past the page, on every driver: a full last page is
`hasMore: false`, never a cursor to an empty one. `cursor: null` (or absent) is the first page, so
`cursor = page.nextCursor` until it is `null` walks the prefix. `limit` is a positive integer or
`X_INVARIANT`. Until 25.0.0 it was `{ objects, truncated, cursor? }` ([Upgrading](Upgrading)).

## A ranged read — `get(key, { range: [first, last] })`

`As of 2026-10-31`. Both offsets INCLUSIVE, as HTTP's `Range:` is. s3 sends ONE signed GET with
`Range:` and reads the window, the size and the etag off that same answer, the local disk slices the file, memory slices its copy. A `last` past the end is
clamped (`read.range` says what was served; `read.object.size` is the whole object's), a `first`
at or past the end is `X_STORAGE_RANGE_UNSATISFIABLE` (416), and `maxGetBytes` bounds the RANGE —
an object refused whole is readable a page at a time.

**A sealed object is not range-readable.** `seal()` writes one AES-256-GCM envelope whose tag
covers every byte, and there is no chunked form of it: a slice neither opens nor means anything.
Page a sealed log by sealing each page as its own object; range-read plain objects.

A ranged read is what `importRows()` reads a large upload with: a `StorageDriver` IS an
`ImportSource` (`stat` + `get(key, { range })`), one page-sized window per step, never the object
whole ([Jobs and workflows](Jobs-And-Workflows#exports-and-imports--exportrows-and-importrows)).

## A large object — `streamRange` and `putStream`

```ts
import { disk } from '@ultimat3/storage';

declare const key: string, first: number, last: number, contentType: string;
declare const request: Request & { body: ReadableStream<Uint8Array> };

export const window = await disk('media').streamRange(key, [first, last]);
export const object = await disk('media').putStream(key, request.body, {
  maxBytes: 2e9,
  contentType,
});
```

| Call | Rule |
|---|---|
| `streamRange(key, [first, last])` | inclusive and clamped, as `get`'s range. No byte before `first` is read and there is no ceiling, because nothing is buffered. A `first` past the end is `X_STORAGE_RANGE_UNSATISFIABLE`, whose fix is `stat(key)`. `/_storage` serves `Range:` through it |
| `putStream(key, stream, { maxBytes, contentType?, cacheControl?, metadata? })` | past the required `maxBytes` the write is abandoned (`X_STORAGE_TOO_LARGE`), the source cancelled and the key left as it was. Ignores `maxPutBytes`, which bounds what `put()` buffers |
| Not taken by `putStream` | `checksum`, `retention`, `legalHold`, `serverSideEncryption`: each needs the bytes before the object exists. A type error, and `X_INVARIANT` for an untyped caller. Use `put()` |
| s3, on the wire | a body under one part is one signed PUT; past it a multipart upload, sent one part at a time, so a part (5 MiB, or `maxBytes / 10000` if larger) is what the process holds. Nothing exists at the key until the Complete; every other exit aborts the upload |
| local | staged under `.meta/.tmp/` and renamed through `put()`'s commit steps. Measured: 1 GiB over a 1 MiB `maxPutBytes` grew RSS by 3 MiB (`As of 2026-11-02`) |
| memory | a `Map` holds bytes: the contract and the refusals, not the memory profile |

Both are required `StorageDriver` methods, so a driver lacking one is a compile error. A third-party
driver reuses `assertPutStream`, `pumpBounded`, `streamLimit`, `assertStreamRange` and `streamedRange`.

## Keys are refused, never sanitised

`assertSafeKey()` runs on every key: `..`, absolute keys, backslashes, control bytes, encoded
separators, empty segments and over-long keys are `X_STORAGE_PATH_UNSAFE`. `scopedKey(org, …)` is
`org/<org>/…`; a surface guards a client key with `isWithinOrg(key, ctx.actor.orgId)` and
`isTenantScoped(key)` (`X_STORAGE_ORG_MISMATCH`).

## The direct-upload round trip

User uploads never go through `put()` (which buffers, and stops at `maxPutBytes`, 10 MB by default).
They go straight to the disk, in three calls — and **the client never names the key**:

| Hop | Call | What it guarantees |
|---|---|---|
| 1. server, in an action | `grantUpload({ disk, orgId: ctx.actor.orgId, request, policy })` | a signed grant for a key the server chose, under the actor's org |
| 2. browser | `uploadFile({ file, grant, onProgress })` | a PUT with real progress; `storage/upload-client.ts` is the one XHR seam in the browser |
| 3. server, at `PUT /_storage/:disk/*key` | mounted by the framework in `x dev` and `runRole`, around `acceptSignedUpload`. Answers `201 { key }` | refuses a bad or expired signature, a key outside the actor's org, more bytes or another type than was granted, or magic bytes that contradict the type |

**The mounted `PUT`** (`As of 2026-09-24`, #523) requires a signed-in actor, like the `GET`. It
needs no permission: the grant is the authorization, and the action that minted it ran its own
policy. The route checks the signature and the expiry, and it checks that the key is inside the
actor's org. It validates the upload against what the grant signed (the content type and
`maxBytes`), so a PDF granted under `uploadPolicy({ allowedContentTypes: ['application/pdf'] })`
is accepted, and it does not use `uploadPolicy()`'s image-only default. The signed `maxBytes` caps
how much of the body is read. `bodyLimitBytes` does not, and neither does an unverified query value.

The signature covers the **constraints** (the disk's base path, method, key, expiry, `maxBytes`,
content type), so editing `?x-max=` invalidates it — and so does moving the URL to another disk:
every local disk signs with the one `STORAGE_SIGNING_SECRET`, and the base path
(`/_storage/<disk>`) is what keeps a grant for `uploads` from verifying on `evidence`. Uploads are
**sniffed**: `validateUpload()` reads magic bytes and refuses a `.png` that is really HTML
(`X_STORAGE_TYPE_REJECTED`). ISO base media files are told apart by their major brand, so
`image/avif`, `image/heic`, `video/quicktime`, `audio/mp4` and `video/mp4` each pass when the
policy allows them; `audio/x-m4a` and `video/x-m4v` are read as `audio/mp4` and `video/mp4`.

**The grant binds the size at the PUT, on every disk** (`As of 2026-11-02`). `request.size` is
required: a grant with no whole byte count of at least 1 is `X_STORAGE_UPLOAD_SIZE_UNDECLARED`, and
`uploadFile` sends the file's own. An s3 disk signs it as the exact `Content-Length`, so the provider
answers any other length, a chunked body included, with 403 `SignatureDoesNotMatch` and stores
nothing. The local disks sign it as the ceiling `acceptSignedUpload` counts against, so a shorter body
passes there and not on s3. `grant.maxBytes` is that declared size. A bare
`disk.signedUrl(key, { method: 'PUT' })` on s3 still binds nothing; with a `maxBytes` and no
`contentLength` it is refused rather than ignored. Proven on the test stack's gateway. A provider
that skips SigV4's signed-header check is the one thing that would unbind it, so
`promoteAttachment` still measures. `get()` refuses an object over the disk's `maxGetBytes` (default:
its `maxPutBytes`, 10 MB) with `X_STORAGE_TOO_LARGE`; read anything larger with `stream()`.

The local disk signs with `STORAGE_SIGNING_SECRET`. The shipped development secret is accepted
**only** in `development` or `test`; a process that names no environment is treated as production
and refused at construction (`X_ENV_MISSING`).

## A large upload, in parts, that resumes

`As of 2026-11-06`. **Past `partThresholdBytes` (64 MiB) a file goes up in parts, and a dropped
connection costs one part, not the file.** One PUT restarts from byte 0 and S3 refuses a single PUT
over 5 GiB. Five server functions, each wrapped in the app's own `action()` as `grantUpload` is,
every one held to the actor's org:

| Call | Answers |
|---|---|
| `grantMultipart({ disk, orgId, request, policy, partBytes? })` | `{ key, uploadId, partBytes, maxParts, contentType, size, expiresAt }`: `grantUpload`'s refusals, then a session. `partBytes` is what 10,000 parts need for `size`, never under 5 MiB |
| `signPart({ disk, orgId, key, uploadId, partNumber, size, policy })` | a PUT URL whose length is signed. s3: S3's own `UploadPart`, presigned by core's signer. Local: `/_storage/<disk>/<key>?x-upload=…&x-part=…`, both inside the HMAC. A part no object under `policy.maxBytes` holds — past `max((partNumber − 1) × 5 MiB + size, partNumber × size)` — is `X_STORAGE_TOO_LARGE` |
| `listParts({ disk, orgId, key, uploadId })` | `{ partNumber, etag, size }[]`, the resume |
| `completeUpload({ disk, orgId, key, uploadId, parts, policy })` | the object. Each named part must have landed, ascending, every one but the last at least 5 MiB (`X_STORAGE_PARTS_INVALID`); the etags are the disk's own, so no bucket CORS has to expose `ETag`. A total past `policy.maxBytes` aborts and is `X_STORAGE_TOO_LARGE` |
| `abortUpload({ disk, orgId, key, uploadId })` | nothing left: no session, no part |

**`policy` is required on `signPart` and `completeUpload`** (`As of 2026-11-07`; no policy is `X_INVARIANT`). The server keeps no record of a grant, and the grant's `size` is the client's own claim, so the policy the app passes on its server is the bound: pass the one the grant was made under, never a value off the request.

```ts
import type { MultipartUploadClient, UploadGrant, UploadRequest, UploadSource } from '@ultimat3/storage';
import { uploadFile } from '@ultimat3/storage';

declare const file: UploadSource;
declare const grantPoster: (request: UploadRequest) => Promise<UploadGrant>;
declare const video: MultipartUploadClient; // the app's five action calls, plus `resume`/`onGrant`

const { key } = await uploadFile({ file, grant: grantPoster, multipart: video });
```

Four parts in flight, each retried with core's backoff. `onProgress` counts confirmed bytes.
`resume: grant` (the one `onGrant` handed over, persisted by the caller) lists what landed and sends
only what is missing. A cancelled `signal` aborts the session; any other failure leaves it open for
the resume. The upload stays under `pending/` until `promoteAttachment`, which sniffs a head window,
so a completed 2 GiB upload is never read whole. On s3 no part passes through the app; on the local
disks the one `PUT /_storage` route takes a part URL as well as a grant's.

A disk whose driver has no `multipart` (a third-party one) is `X_STORAGE_MULTIPART_UNSUPPORTED`; a
session that was completed, aborted or never opened is `X_STORAGE_UPLOAD_UNKNOWN`.

## Which disks `/_storage` and `/media` serve

`As of 2026-09-24` (#524): **the app's own.** Both routes read the process's one registry per
request. That registry is the last `defineStorage()` call, which is the app's when an app module
declares its disks. The boot's env-selected disk (`object` on `S3_ENDPOINT`, else `local`) is
served only when nothing declared one. A `defineStorage` at module scope in any file under
`apps/*/` is enough:

```ts
// apps/web/shared/storage.ts
export const storage = defineStorage({
  disks: { uploads: localDriver({ root: '.storage/uploads' }), evidence: s3Driver({ bucket }) },
  default: 'uploads',
});
```

| | |
|---|---|
| `storage:read` | the `GET` requires it. An app that serves nothing through these routes leaves it out of its permission set: every read is then `401` for nobody and `403 X_FORBIDDEN` for everyone else (27.0.0). Until then an undeclared `storage:read` was a runtime `500 X_PERMISSION_UNKNOWN`, which `x verify`'s `policy` step reported |
| the boot's own disk | still built. In production with no `S3_ENDPOINT`, that is a local disk and still needs `STORAGE_SIGNING_SECRET`. To skip it, set `storage:` in `export const runtime = { … }` (`apps/<app>/runtime.ts`) to a `StorageDriver`: the boot registers it as its one disk, under the driver's own `name`, in place of the `S3_ENDPOINT`/embedded decision. Several disks are still `defineStorage()`, which wins ([Adapters](Adapters#storage)) |
| `definedStorage()` | the registry or `undefined`, without a throw. It is the question the routes ask |

## Who may read a stored object

`As of 2026-10-08` (27.0.0): **`GET /_storage/:disk/*key` and `GET /media/*key` decide on the
session, the policy and the key — in that order — and a key no tenant owns is refused unless the
app shared it.**

| Key | Served to | Otherwise |
|---|---|---|
| `org/<id>/…` | a signed-in actor holding `storage:read` whose `orgId` is `<id>` | `X_STORAGE_ORG_MISMATCH` (404) |
| under a prefix `defineStorage({ shared })` lists **for that disk** | a signed-in actor holding `storage:read` | — |
| anything else — `db-export/…`, `raw/…`, `dsr/…` | nobody | `X_STORAGE_KEY_UNSHARED` (404) |

Both refusals are decided from the key alone, before a disk is read, so neither says whether an
object exists. Until 26.x the third row was served to every holder of `storage:read`: "not another
tenant's" was read as "everybody's".

```ts
import { defineStorage, localDriver, s3Driver } from '@ultimat3/storage';

defineStorage({
  disks: {
    uploads: localDriver({ root: '.storage/uploads' }),
    evidence: s3Driver({ bucket: 'evidence' }),
  },
  shared: { uploads: ['brand/'] }, // whole segments, ending in '/'; never 'org/'
});
```

A prefix is refused at boot (`X_CONFIG_INVALID`) when it names an undeclared disk, lacks its
trailing `/`, would share the whole disk, or sits inside `org/`. `storage.isShared(disk, key)` is
the question both routes ask.

**The `GET` does not read `x-sig` or `x-exp`.** A signed GET URL `localDriver` mints points at
this route, and is served on the terms above whatever its signature says: it neither opens an
unshared key nor outlives the session. To serve an object by signature alone (no session), mount
your own route around `readSignedObject({ url, disk, orgId })`, or return the bytes from an action.

## Serving an object to a stranger

`As of 2026-11-02`. **A file of the site is an `asset()`; a stored object is your route and
`objectResponse`.** A shared prefix still needs a signed-in reader, so it cannot express an object
whose authorization is app state (a published row): that decision is your route's, and the answer
is the framework's.

```ts
import { byteWindow, objectResponse, type UltimateRequest } from '@ultimat3/http';
import { objectNotFound, storage } from '@ultimat3/storage';

declare function publishedPost(id: string): Promise<{ imageKey: string }>;

export const handler = async (request: UltimateRequest): Promise<Response> => {
  // Your rule first, from your own row. Nothing here reads a session.
  const post = await publishedPost(request.params['id'] ?? '');
  const disk = storage().disk();
  const object = await disk.stat(post.imageKey);
  if (object === undefined) throw objectNotFound(disk.name, post.imageKey);
  return objectResponse(
    request,
    {
      object,
      open: async (range) =>
        range === undefined
          ? disk.stream(post.imageKey)
          : byteWindow(await disk.stream(post.imageKey), range),
    },
    { cache: { mode: 'public', maxAgeSeconds: 300 } },
  );
};
```

| It answers | When |
|---|---|
| `200`, stored type, `content-length`, `etag`, `last-modified` | a plain `GET`. No etag known: no `etag` header, and no `304` |
| `206`, `content-range` | one `Range:` window; `open` receives it, so it opens exactly those bytes |
| `304` · `416` | a matching `if-none-match` · a window past the end. Neither opens anything. An `if-range` that is not this revision ignores the range: `200`, whole |
| `content-disposition: attachment` + `content-security-policy: sandbox` | any type but a raster image, audio or video. `headers` replaces this rule for a caller with its own |
| your `cache`, on every status | omitted, the route's `meta.cache` decides |

`request` needs only `header(name)`, and `object` only `{ contentType, size, etag?, lastModified? }`:
`@ultimat3/http` imports no storage, so a `StorageObject` fits and so does anything else.

**Test the real route.** `storageRoutes({ storage })` from `@ultimat3/cli` returns the mounted
`GET` and `PUT` (`servedStorage(storage)` is the registry they read), as `assetRoutes` returns
`/media`, so an app's contract test drives the route its deploy serves rather than a copy.

**The body is streamed** (`stat` + `stream`), never buffered: an object past the disk's
`maxGetBytes` is served, and a `Range` reads and drops the bytes before its start rather than
holding the object. `/media` streams the object the same way, and buffers a variant only: it
decodes images.

**One cache posture on both routes** (`As of 2026-11-02`): `private, max-age=0` plus an `etag`, for
every key. A key is not content-addressed, since an overwrite changes the bytes under it, so
nothing here answers `immutable`: `/media` once did on a shared key, and a CDN then served it to
strangers for a year and never refreshed it. A public image is an `asset()`, or your own route over
`objectResponse`.

## Attachments, quarantine, orphans

An upload lands under `org/<org>/pending/…` before its row exists, and is promoted once it has one:

| Call | Does |
|---|---|
| `promoteAttachment({ disk, key, orgId, target, policy })` | measure, copy, then delete, onto `org/<org>/<entity>/<id>/<field>/…`. **`policy` is required** — pass the one the upload was granted under: the object's size is read with `stat()` and one over `policy.maxBytes` is `X_STORAGE_TOO_LARGE` and stays pending. Only a **pending** key: another row's attached key is `X_STORAGE_NOT_PENDING`. A second call for a key an earlier call already moved is `X_STORAGE_ALREADY_PROMOTED` (409, `meta.attachedKey`) and touches nothing: answer the row that holds that key, and never delete it in your own cleanup |
| `grantUpload({ …, quarantine: true })` → `releaseQuarantine({ disk, key, orgId })` | the place for your scanner: a quarantined key cannot be promoted (`X_STORAGE_QUARANTINED`) until your scan job releases it. The scanner is your app's (axiom 8) |
| `sweepOrphans({ disk, orgId, olderThanMs })` | deletes stale `pending/` keys of one org and answers `{ deleted, failed }` — a refused delete is reported, never counted as done |
| `deleteVariants({ disk, key })` | deletes every stored variant of one source, of every revision, and answers `{ deleted, failed }`. The source is yours to delete. A variant keeps its source's prefix, so an org-wide erasure by prefix already collects them |

**An erasure of one object must call `deleteVariants`.** `disk.delete(key)` removes the source only.
Once it is gone `/media` and `/_storage` answer `X_STORAGE_NOT_FOUND` for the variant too, but its
bytes stay on the disk, and a variant minted before revisions (`hero.png@w640.webp`) names no revision
and stays readable by its own key. Delete the source and its variants, and report `failed`.

**Promotion also reads the object** (`As of 2026-11-02`). A presigned PUT on an s3 disk signs `host`
and the size, so the uploader chose the stored type and the bytes. `promoteAttachment` reads the first
`SNIFF_WINDOW_BYTES` (64 KiB) with one ranged read and judges them by the rule the upload path uses
(`validateStoredHead`); a contradiction is `X_STORAGE_TYPE_REJECTED`, and the key stays pending.

The upload URL stays valid after that read, so the copy names the revision judged (`ifMatch`: on s3,
`x-amz-copy-source-if-match`), and another is `X_STORAGE_OBJECT_CHANGED` (409). The copy is then
checked: another size is refused and deleted; an etag that differs or is unknown (a disk with none, or
SSE-KMS, which mints one per copy) means the copy's own head is judged, and refused and deleted if it
does not pass. Bytes past the window are not sniffed on any path through promotion.

| Refused at promotion | Why |
|---|---|
| an XML or `+xml` object over 64 KiB | a browser runs a script anywhere in an XML document, and the window cannot see all of it. Upload it through the server: `validateUpload` reads the whole body |
| over 4,096 bytes of leading whitespace (`MAX_LEADING_WHITESPACE`), on every path | no real file opens that way, and past the window nothing is seen |
| a disk whose `maxGetBytes` is under the window | its own `X_STORAGE_TOO_LARGE`: the ceiling bounds the range |

A grant with a `target` has no promotion step: [Known gaps](Known-Gaps).

## Scanning uploads — the `uploadScanner` port

Rule: an `uploadScanner` returned from `apps/<app>/runtime.ts` is asked about every upload `promoteAttachment` attaches. `As of 2026-11-09`. It scans a copy THIS call made: under `pending/scan/`, server-named — so no presigned URL can rewrite it after the scan — and its own, so a doubled confirm never scans or deletes another attempt's bytes. That copy is what is attached; one scan is final.

| Verdict | `promoteAttachment` |
|---|---|
| `{ verdict: 'clean' }` | promotes |
| `{ verdict: 'infected', signature }` | deletes the pending upload and the scan copy; `X_STORAGE_UPLOAD_INFECTED` (422, `meta.signature`) |
| the scanner rejects, or the copy cannot be read for it (daemon down, timeout, a reset read) | deletes the scan copy, the upload stays pending — a retry once the scanner is back is a fresh confirm; `X_STORAGE_SCAN_UNAVAILABLE` (503). Fail closed in every environment; `uploadPolicy({ onScanUnavailable: 'accept' })` promotes unscanned instead. Infected is refused under either |

| Fact | Detail |
|---|---|
| the port | `UploadScanner = { name, scan({ key, size, contentType, body }) → Promise<ScanVerdict> }` on `@ultimat3/storage/adapter`. "Cannot decide" is a rejection, never a verdict |
| the reference | `memoryUploadScanner()` flags the EICAR test string (`EICAR_TEST_STRING`), across chunk boundaries |
| prove yours | `behavesLike(uploadScannerConformance, () => yours)` from `@ultimat3/testing/conformance` |
| ClamAV | the app's adapter (axiom 8): stream `body` to clamd's `INSTREAM` over `Bun.connect`; `stream: OK` → clean, `stream: <sig> FOUND` → infected, anything else → reject |
| no scanner installed | nothing is scanned; the deferred `quarantine: true` + `releaseQuarantine` flow below is unchanged |

```ts
// apps/web/runtime.ts
import type { RuntimeOverrides } from '@ultimat3/cli/serve';
import type { UploadScanner } from '@ultimat3/storage/adapter';

declare function clamdScanner(options: { host: string; port: number }): UploadScanner;

export const runtime = {
  uploadScanner: clamdScanner({ host: 'clamav', port: 3310 }),
} satisfies Partial<RuntimeOverrides>;
```

## Images

A variant's key is the whole source key plus the transform — `photos/hero.png` at width 640 is
`photos/hero.png@w640.webp` — so two sources that differ only by extension never share a cached
variant. `width` and `height` are whole numbers of at least 1 (`X_INVARIANT` otherwise).

`/media` keys what it stores on the bytes and the encoding as well: `photos/hero.png@w640-r0123abcd.png`,
`r<8 hex>` being `variantRevision(object.etag)` and the format the `?f=` asked for, else the source's
(`variantFormatOf`). It reads the source first, so a deleted source is `X_STORAGE_NOT_FOUND` whatever
is still stored, and an overwrite misses every old variant. The variant's own key answers for its
source too, on both routes: once the source is gone or holds another revision, it is
`X_STORAGE_NOT_FOUND`. A source no key can state, a `gif` or an
unknowable etag, is served and never stored. Old-revision variants are bytes nobody reads:
`deleteVariants` or a bucket lifecycle rule removes them, and when is yours to choose.

`transformImage()` and `blurPlaceholder()` run on core's pipeline (`Bun.Image`, no `sharp`) and
encode `png`, `jpeg` and `webp`; `avif` is key and `srcset` math only. `variantKey()`,
`srcsetDescriptors()` and `fitDimensions()` are pure, which is how [SEO](SEO) builds `srcset`
without decoding a byte.

### One kept variant — `variant()`

`variant(key, { disk, images, width, format? })` → `{ key, object, created }`. `As of 2026-11-09`. Made by the `images` driver you pass (any `@ultimat3/seo` `ImageTransformDriver` — `runtime.ts`'s `images`, `builtinImageDriver({ read })`, a CDN's), stored under `variantKey(key, { width, format, revision })`. A second call is a `stat`, never a decode; an overwritten source is a new revision, hence a new key. `format` omitted keeps a png/jpeg/webp source's encoding.

| Refusal | Code |
|---|---|
| source missing | `X_STORAGE_NOT_FOUND` |
| source not a raster image (PDF, SVG), a gif/avif source with no `format`, a driver that answered another encoding | `X_IMAGE_UNSUPPORTED` |
| source overwritten while the driver read it (nothing stored) | `X_STORAGE_OBJECT_CHANGED` |

```ts
import { builtinImageDriver } from '@ultimat3/seo';
import { disk, variant } from '@ultimat3/storage';

declare const coverKey: string;

const images = builtinImageDriver({ read: async (src) => (await disk().get(src)).bytes });
export const thumbnail = await variant(coverKey, { disk: disk(), images, width: 640, format: 'webp' });
```

### Warm the variants after the upload — `warmVariants`

The first request for each width otherwise pays the decode on the request path. A job the upload
enqueues pays it once instead, under the exact keys `/media` reads:

```ts
import { disk, warmVariants } from '@ultimat3/storage';

const warmed = await warmVariants({
  disk: disk(),
  key: 'org/o1/member/m1/avatar/a.png',
  widths: [48, 96, 192],
  formats: ['webp'],
});
```

`{ written, failed, skipped }`: the revision is read off the source it decodes, so a variant is never
keyed to bytes it was not made from; a width above the source's is `skipped`, never an upscale; an
`avif` fails alone with core's `X_IMAGE_UNSUPPORTED` and the rest are still written. The source is
read and probed once and held to `MAX_IMAGE_PIXELS` before a pixel is decoded. `As of 2026-11`.
`examples/dummy`'s `app/orgs/jobs/warm-avatar.ts` is the worked job.

## Expiry — `expireObjects` and `abortStaleUploads`

`As of 2026-11-06`. **The window is the app's, at the call; the sweep runs on every disk.** A local
disk has no bucket rule, and an abandoned upload's parts bill until something aborts them.

| Call | Does |
|---|---|
| `expireObjects({ disk, prefix, olderThanMs, keep?, clock? })` | deletes every object under `prefix` past the window. `{ deleted, failed, spared }`: undated, kept or new is spared, a locked object is `failed` and never forced. An empty `prefix` (the whole disk) is refused |
| `abortStaleUploads({ disk, olderThanMs, prefix?, match? })` | aborts every session opened before the window: `{ aborted, failed, spared }` |
| `objectPurgeTarget({ name, disk, prefix, match?, olderThanMs })` | both, as one target of the app's `purge()` job (`@ultimat3/jobs`), on the job's clock. No timer in storage. `match(key)` scopes both sweeps under `prefix`: a per-tenant layout (`org/<id>/imports/…` beside `org/<id>/member/…/avatar`) is one kind of file no single prefix names, so `prefix: 'org/', match: (key) => /^org\/[^/]+\/imports\//.test(key)` sweeps every org's imports and spares the avatar beside each |

A person's stored objects are a subject target: `storageSubjectTarget(() => disk(), keysOf, {
name? })` lists the keys `keysOf(subject)` names (a list, or a prefix the app lists) for
`subjectExport()` and deletes them for `subjectErase()`. Which keys are the person's is the app's;
there is no listing by owner. [Jobs and Workflows](Jobs-And-Workflows#one-persons-data--subjectexport-and-subjecterase).

Every `X_STORAGE_*` code is in [Error codes](Error-Codes). Encryption at rest, bucket lifecycle
rules and storage classes stay **bucket** configuration, the operator's (axiom 7): `expireObjects`
is the sweep an app runs, not a rule the framework writes to a bucket.
