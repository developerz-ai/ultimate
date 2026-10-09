# @ultimat3/storage 🗄️

Named disks. **Call sites name a disk, never a driver.**

```ts
import { defineStorage, disk, localDriver, s3Driver, scopedKey } from '@ultimat3/storage';

defineStorage({
  disks: {
    uploads: localDriver({ root: '.storage/uploads' }),
    media: s3Driver({ bucket: 'media', endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }),
  },
  default: 'uploads', // omit and the first disk wins
  shared: { media: ['brand/'] }, // the only un-scoped keys /_storage and /media serve (27.0.0)
});

await disk('media').put(scopedKey(orgId, 'avatars', 'a.png'), bytes, { contentType: 'image/png' });
```

Swapping `local` for `s3` in `app.config.ts` changes no call site. `x dev` needs no S3 server.

`shared` is per disk, whole segments ending in `/`, never inside `org/` (`X_CONFIG_INVALID` at
boot). A key outside every `org/<id>/` prefix and every shared prefix is refused by the served
read routes with `X_STORAGE_KEY_UNSHARED` (404); `storage.isShared(disk, key)` is the question.

## Drivers

| Driver | Backing | For | Signed URLs |
|---|---|---|---|
| `localDriver` | `Bun.file`/`Bun.write`, one root dir | dev, tests, single-node | HMAC + dev route |
| `s3Driver` | `Bun.s3`, plus core's `signAwsRequest` over `fetch` for the requests Bun has no option for | prod: any S3-compatible endpoint — AWS, R2, a self-hosted gateway | provider presign |
| `memoryStorageDriver` | a `Map` in this process | a TEST's disk — never a deployment's: a restart is every object gone | HMAC, the local disk's own |

`memoryStorageDriver()` is what a suite holds instead of a temp directory or a hand-written fake: it
answers every method `localDriver` does, refuses what it refuses (an unsafe key, a wrong checksum,
a body past `maxPutBytes`, `serverSideEncryption`), and signs under the same rule — the published
development key in `development` and `test` only. `objects()` hands back a COPY of every stored
object's bytes by key, for the assertion a test makes about the bucket itself.

```ts
import { afterEach, beforeEach } from 'bun:test';
import { defineStorage, disk, memoryStorageDriver, resetStorage } from '@ultimat3/storage';

// A fresh driver per test: `resetStorage()` forgets the REGISTRY, never a driver's objects, so a
// driver held across tests carries every earlier test's writes.
let sessions = memoryStorageDriver();
beforeEach(() => {
  sessions = memoryStorageDriver();
  defineStorage({ disks: { sessions } });
});
afterEach(() => resetStorage());

await disk('sessions').put('org/o1/session.json', new TextEncoder().encode('{"sealed":"x1.…"}'));
const stored = [...sessions.objects().values()].map((bytes) => new TextDecoder().decode(bytes));
```

Server-side only, like both other drivers: nothing an island imports reaches it.

`region` is what requests are signed for; unset, that is `auto`. An endpoint that expects another
region refuses the first write, list or delete with `X_CONFIG_INVALID`, and the fix names the
`S3_REGION` to set.

`copy(from, to)` is on the contract so a promotion is not a download-and-reupload:
`promoteAttachment` used to `get()` the whole object into the app and `put()` it back, a gigabyte
through the pod to rename a 500MB attachment. `localDriver` does a real file copy; `s3Driver`
hands the source `S3File` to `write()` — Bun exposes no `CopyObject`, so the bytes still cross the
network, but never this process's heap. Both arguments go through `assertSafeKey`.

One S3 driver covers all three backends — the difference is `endpoint` + `forcePathStyle`.
Credentials are **env var NAMES** (`accessKeyIdEnv`, default `S3_ACCESS_KEY_ID`), never
literals: a key in `app.config.ts` is a key in git. Missing ones throw `X_ENV_MISSING`.
Endpoint, region and session token resolve ONCE for both transports, as Bun reads them: the
option, then `S3_ENDPOINT`/`AWS_ENDPOINT`, `S3_REGION`/`AWS_REGION`,
`S3_SESSION_TOKEN`/`AWS_SESSION_TOKEN` (or the one `sessionTokenEnv` names), from
`s3Driver({ env })` or `process.env`. `s3Driver({ fetch, clock })` inject the signed path's transport and its clock (tests; default the
global `fetch` and `systemClock`); `S3FetchLike` is the shape.
`localDriver` keeps content type, etag, `cacheControl` and `metadata` in a `<root>/.meta/`
sidecar so `get()`/`list()` round-trip everything `put()` was handed; sidecars never appear in
`list()`. `s3Driver` STORES both — a `put()` carrying `cacheControl`, `metadata`, `retention` or
`legalHold` goes past the Bun client as one SigV4-signed PUT (`x-amz-meta-*`, `Cache-Control`,
`Content-MD5`), against the same endpoint, region and credentials — but its `get()`/`stat()` read
through Bun's HEAD, which exposes neither, so there they are absent rather than invented. A plain
`put()` stays on the Bun client. A metadata name must be a header token and every value printable
ASCII (`X_INVARIANT` otherwise): S3 carries them as headers.

**The local disk writes an object by rename, in an order no crash can make lie.** An object there
is two files, so a `put()` or `copy()` stages bytes, sidecar and a *pending marker* (the new etag)
under `<root>/.meta/.tmp/` and then: renames the marker to `.meta/<key>.json.pending`, renames the
sidecar, renames the bytes, removes the marker. What a reader sees if the process dies:

| Died before | Fresh key | Overwrite |
|---|---|---|
| the marker or the sidecar rename | absent | the previous object, whole |
| the bytes rename | absent (a sidecar alone is no object) | the previous BYTES; `get`/`stat` answer `application/octet-stream` and the bytes' own etag, `list` no type and `etag: ''` — never the new type |
| clearing the marker | the new object to `get`/`stat` (re-checked against the bytes); `list` reports it untyped until the next put | same |

No row serves a content type or an etag the bytes were not checked against. A marker that
cannot be cleared after the renames landed is not a failed put — the object is committed and the
last row is what it leaves. `stat()`, `list()` and a copy's source read queue behind the key's
writer exactly as `get()` does. Writers and `get()` of
ONE key are also serialised inside a process, so two concurrent puts cannot interleave; across
processes the marker is what covers the window. `stream()` hands back bytes with no metadata and
checks nothing. The layout is otherwise unchanged — an existing root needs no migration.

**A refused write is coded.** `EACCES`, `ENOSPC`, `EROFS` or a root that is a file on the local
disk, and a provider's refused PUT on s3, are `X_STORAGE_PUT_FAILED` from `put()` and `copy()`,
with the errno or provider code in the cause. `put()` options are held to their types first
(`assertPutOptions`: string `contentType`/`cacheControl`, a plain object of strings for
`metadata`, `X_INVARIANT` otherwise) on all three drivers. A refused READ is `X_STORAGE_READ_FAILED` the same
way. No driver method leaves with a bare throw for a wrong-typed argument either: a key that is not
a string is `X_STORAGE_PATH_UNSAFE`, a body that is not bytes, a `Blob` or a stream and a
non-string `list()` prefix or cursor are `X_INVARIANT` (`driver-read-failed.test.ts` sweeps every
method on every disk). The one thing no code can cover is a `stream()` that fails after it was
handed back: that is the stream's own error.

**A key cannot be another key's path on the local disk — or on the memory disk standing in for
it.** A POSIX path is a file or a directory: `put('a')` then `put('a/b')` — or the reverse, a
`copy()` onto either, or `a` beside `a.json/b`, which collide in the sidecar tree — is
`X_STORAGE_KEY_CONFLICT`, refused before a byte moves, where it used to be a bare `ENOTDIR` /
`EISDIR`. Its `fix` names the disk as `defineStorage` registered it, not the driver kind.
`memoryStorageDriver` refuses the same keys with the same `blocking` (a suite on it stands in for
`x dev`'s disk); `s3Driver` holds both. `driver-local-memory-parity.test.ts` holds local and memory
to one answer, `driver-contract.test.ts` pins the s3 divergence. `delete()` of a key that is only
another key's directory (`delete('c')` beside `c/d`) is deleting an absent key: not an error, and
nothing beneath it is touched.

`stat(key)` answers what a read would — size, type, etag, age — **without the bytes**, and
`undefined` for nothing there. It is a required `StorageDriver` method: `promoteAttachment` measures
with it, and a driver that cannot measure does not compile.

`lastModified` is **optional** on a listing entry and on a `StorageObject`: absent when the
provider reported none, never epoch 0 — which `sweepOrphans` read as "older than any window" and
deleted. A reader that needs an age handles `undefined`; the sweep spares it. On the local and
memory disks it is the write's instant on the disk's injected `clock`: what `put()`/`copy()`
returned is what every later `stat`/`get`/`list` reports (the local disk records it in the
sidecar; an object written before that, or with no trusted sidecar, reports the file's mtime).

**`StorageListEntry.contentType` is optional; `StorageObject.contentType` is not.** S3's
`ListObjectsV2` returns no Content-Type, so a listed s3 object simply has none — reading the real
value would cost one `HeadObject` per row, which is what `list()` exists to avoid. It used to
report `application/octet-stream`, indistinguishable from an object that really is one, while the
local driver read the truth out of its sidecar: a caller filtering a listing by content type got
everything on `local` and nothing on `s3`. `get()` always answers a full `StorageObject`.

The etag follows the same rule: a listed object with no sidecar reports `etag: ''`, because
answering otherwise means reading and hashing the whole object — which is what the local `list()`
used to do, once per sidecar-less row, sequentially. `get()` hashes out of bytes it already holds.

**A listing returns every key the key rules allow**, dot-prefixed segments included
(`.hidden.txt`, `org/o1/pending/.x.png`) — the local glob was blind to them until 2026-08, so a
disk answered `exists()` true and `list()` nothing for the same object. **`limit` is a positive
integer or a refusal** (`X_INVARIANT`, at the `ListOptions` seam): `limit: 0` used to read back as
a complete, empty page on the local disk and as `maxKeys: 0` on s3.

**A listing is core's ONE `Page`** — `Page<StorageListEntry>`, the shape an entity `findMany` and
a query `.page()` answer: `{ rows, nextCursor, hasMore }`, `nextCursor` a string exactly when
`hasMore` is true. The cursor exists only when another object does — the local and memory disks
look one key past the page, s3 reads `IsTruncated` and takes `NextContinuationToken` — so a full
last page answers `hasMore: false`, never a cursor to an empty page. `cursor: null` is the first
page, so a walk threads `nextCursor` straight back:

```ts
import type { Page } from '@ultimat3/core';
import { disk, type StorageListEntry } from '@ultimat3/storage';

const keys: string[] = [];
let cursor: string | null = null;
do {
  const page: Page<StorageListEntry> = await disk('uploads').list({ prefix: 'org/o1/', cursor });
  keys.push(...page.rows.map((object) => object.key));
  cursor = page.nextCursor;
} while (cursor !== null);
```

Before 25.0.0 it was `ListPage { objects, truncated, cursor? }`, its own shape beside core's.

## `put()` is for objects that fit in memory

`put()` buffers the whole body — size and checksum have to be known before the object exists —
so every disk enforces a ceiling, `maxPutBytes`, defaulting to `DEFAULT_MAX_UPLOAD_BYTES` (10MB).
Past it is `X_STORAGE_TOO_LARGE`, raised **before** the bytes are resident: a `Uint8Array` and a
`Blob` already know their length, and a `ReadableStream` is cancelled the moment the running total
crosses the line. Without it a route piping a 4GB request body into `disk.put(key, req.body)` grew
the heap by 4GB and the kubelet killed the pod.

**User uploads never go through `put()`.** They go direct to the disk through `grantUpload`, which
is the architecture and not an optimisation — see the round trip below. Raise `maxPutBytes` only
for a disk that really does write large objects server-side, and remember S3 caps a single PUT at
5GB whatever you set.

**`get()` buffers too, so it has the same ceiling**: `maxGetBytes`, on all three drivers,
defaulting to that disk's `maxPutBytes`. An object past it is `X_STORAGE_TOO_LARGE` — decided on
the disk's own size (a HEAD on s3) before a byte is read — and is read with `stream()`. It exists
because an object's size is not the server's to choose: a presigned PUT lands in a bucket
unmeasured, so a later `get()` of it was heap growth the uploader picked.

## Write-once objects (S3 Object Lock)

```ts
import { systemClock } from '@ultimat3/core';
import { disk, isLocked } from '@ultimat3/storage';

const key = 'org/o1/ledger.csv';
const bytes = new TextEncoder().encode('a,b\n');
const now = systemClock.now();
await disk('ledger').put(key, bytes, {
  retention: { mode: 'COMPLIANCE', retainUntil: new Date(now.getTime() + 7 * 86_400_000) },
  legalHold: true,
});
const lock = await disk('ledger').retentionOf?.(key); // { retention: { mode, retainUntil }, legalHold: true }
isLocked(lock, now); // a hold, or a retention still ahead
```

| | s3 | local, memory |
|---|---|---|
| `put({ retention, legalHold })` | `x-amz-object-lock-mode` / `-retain-until-date` (ISO) / `-legal-hold` (`ON`/`OFF`) on the signed PUT — the bucket must be CREATED with Object Lock | recorded in the sidecar (local) or beside the bytes (memory) |
| `retentionOf(key)` | signed `GET ?retention` + `?legal-hold`; a bucket without Object Lock, or an object with none, is `{ legalHold: false }` | from what `put()` recorded |
| `delete` / overwrite of a locked object | sent: S3 locks a VERSION, so a DELETE writes a delete marker and a PUT a newer version — the locked version stays | **refused** — `X_STORAGE_OBJECT_LOCKED` (`ObjectLockedError`, HTTP 409; `.lock` carries the lock) — until it lapses: one version per key, so refusing is the only way to keep the bytes |

`retainUntil` must be a valid instant in the future and `mode` `GOVERNANCE` or `COMPLIANCE`
(`X_INVARIANT` before a byte moves). `COMPLIANCE` cannot be shortened by anyone; extending a
retention, releasing a hold or bypassing `GOVERNANCE` is out of band:
`aws s3api put-object-retention` / `put-object-legal-hold`. A `copy()` does not carry the source's
lock — on S3 it is per version and set by the request. The local refusal is in-process
(`keyedQueue`), like every other local write rule.

## Server-side encryption, storage classes, lifecycle

`PutOptions.serverSideEncryption` exists so the gap is visible **at the type level**, and every
shipped driver refuses it (`X_NOT_IMPLEMENTED`) with the out-of-band command in the `fix`.
`Bun.S3Client` exposes `acl`, `storageClass` and `type` and nothing for
`x-amz-server-side-encryption*`; a local disk writes plain files. A typed refusal an engineer
meets at the call site beats a silent absence discovered during a security review.

Encryption at rest is therefore a **bucket default**, and so are lifecycle rules, storage classes
and cross-region replication: all four are bucket-side configuration and belong to terraform, not
to the framework (axiom 7 — zero platform primitives). Ultimate half-building any of them would
be a second place to look for the same setting.

## Keys

`assertSafeKey()` runs on every key before it reaches a driver. Rejected: `..` segments,
absolute keys, backslashes, NUL/control bytes, percent-encoded separators (`%2e`, `%2f`),
empty segments, over 1024 chars, and a first segment of `.meta` (`META_DIR`) — the local driver's
sidecar namespace, reserved on **every** driver so one key rule covers disk and S3 alike. Without
it, `put('.meta/a/b.json', …)` overwrote the recorded content type of `a/b` and a route serving
that object answered attacker HTML from the app's own origin. No sanitising — a key that needed
fixing was built wrong.
`scopedKey('org-1', 'avatars', 'a.png')` is `org/org-1/avatars/a.png`; guard every
client-supplied key with `isWithinOrg(key, ctx.actor.orgId)` — a predicate that never throws: an
org id that cannot be one (empty, or carrying a separator) contains nothing, so an actor with no
org claim is `false` and not an `X_STORAGE_PATH_UNSAFE` blaming the key. A surface that serves objects pairs
it with `isTenantScoped(key)`: only a key already inside `org/` is another tenant's to refuse, so
`disk().put('brand/logo.png', …)` stays reachable while `org/org-2/…` never is. `accept.ts` asks
the pair too. `isTenantScoped` folds case (`Org/`, `ORG/`) and `isWithinOrg` does not, so a
case-variant prefix — one directory, not two, on APFS or NTFS — is refused rather than matched.

## Signed URLs

The HMAC covers the **constraints**, not just the key —
`v2 \n basePath \n METHOD \n key \n expiresAt \n maxBytes \n contentType`.
A client that edits `?x-max=` invalidates the signature — it cannot widen what it was granted.

`basePath` is the disk: the PATH of the base the URL was minted under (`/_storage/<registered
name>`). Every local disk signs with the one `STORAGE_SIGNING_SECRET`, so without it a URL for
`uploads/<key>` verified on `private/<key>` with only the path segment edited. The origin is not
signed — the route that verifies is handed a path — and an absolute `baseUrl`
(`https://cdn.example.com/_storage/local`) is compared by its pathname (`signedUrlBasePath`), where
it used to make every URL minted under it `malformed`. `canonicalRequest` and `signConstraints`
take the base path as their last argument.

The HMAC key is `signingSecret`, else `STORAGE_SIGNING_SECRET`, else the shipped
`DEV_SIGNING_SECRET` — and **only in `development` or `test`**, read with a fallback of `production`: a process that names no environment at all (`ULTIMATE_ENV` and `NODE_ENV` both unset) is refused like a production one, `As of 2026-09-23`. Anywhere else `localDriver` refuses
to construct (`X_ENV_MISSING`) unless one of those two is set to something that is not the shipped
literal: the dev literal is published in this repo, so signing with it lets anyone mint a `PUT` for
any key with a `maxBytes` and `contentType` of their choosing, which `acceptSignedUpload` then
trusts over the app's own `uploadPolicy`. Setting `STORAGE_SIGNING_SECRET=$DEV_SIGNING_SECRET`, or
pasting the literal into `signingSecret`, is refused exactly as an unset variable is. `usesDevStorageSecret()` is the
`x doctor` probe for it, the twin of core's `usesDevCursorSecret()`.

Both read **one table**, and `env` is how a caller says which. `localDriver({ root, env })` reads
the secret, the environment test and the environment the refusal names off that table;
`usesDevStorageSecret({ env })` reads it off the same one. Both default to `process.env`, so a bare
call is unchanged — pass `env` wherever the boot's environment is not the process's (`serveApp({ env })`,
a test fixture), or the guard answers about one process and the disk signs according to another.
Verification is constant-time, checks the signature *before* the expiry (a forged URL never
learns it was merely late), takes a `Clock` so tests freeze time, and returns
`{ ok: false, reason }` rather than throwing — `malformed | unsafe-key | signature-mismatch |
expired`. S3 presign covers method, expiry and content type but **not** `maxBytes`: S3 has no
header for it, so a bucket-backed disk's ceiling is a bucket rule or a post-upload `object.size`
check, never the signature. `s3Driver` does not refuse `maxBytes` either — `grantUpload` supplies
it on every grant, so refusing would break every s3 upload an app mints.

## Uploads sniff the content type

`Content-Type` is attacker-controlled. A `.png` that is really an HTML document is stored XSS
the moment a surface serves it back with the declared type. `validateUpload()` reads the magic
bytes (PNG, JPEG, GIF, WebP, PDF, ZIP/OOXML, SVG, the ISO-BMFF family, HTML, plain text) and
rejects any payload whose bytes contradict the declaration. Checks run cheapest-first: key → size →
allowlist → sniff → checksum.

Every ISO base media file opens with the same `ftyp` box, so the box alone says "container" and
the **major brand** after it decides (`iso-bmff.ts`): `avif`/`avis` → `image/avif`, `heic`/`heix`…
→ `image/heic`, `qt  ` → `video/quicktime`, `M4A `/`M4B ` → `audio/mp4`, `3gp*` → `video/3gpp`,
anything else → `video/mp4`. Two brands name only a container and stand in as `application/zip`
does for OOXML: `video/mp4` for a declared `audio/mp4` (an audio-only MP4 carries `isom`), and
`image/heif` (`mif1`) for `image/heic` and `image/avif`. `audio/x-m4a` and `video/x-m4v` — what a
browser reports for a picked file — normalise to `audio/mp4` and `video/mp4`, and
`uploadPolicy({ allowedContentTypes })` normalises its list the same way, so an alias in an
allowlist names the type it means.

`validateUpload({ key, declaredContentType, bytes }, uploadPolicy({ maxBytes: 5e6 }))`

## The direct-upload round trip

Three calls, one per hop. The **client never names the key** — it asks for a grant and is told
one — so it cannot aim an upload at another tenant, at a row it does not own, or at a size the
policy never allowed.

```ts
// 1. server, inside an action's handle: mint the grant
const grant = await grantUpload({
  disk: disk('uploads'),
  orgId: ctx.actor.orgId,            // the ACTOR's org, never one read off the request
  request: { filename, contentType, size },
  policy: uploadPolicy({ maxBytes: 5e6 }),
  // target: { entity: 'post', id, field: 'cover' } — omit it and the key lands under `pending/`
});

// 2. browser: PUT at it, with real progress, and get the key back
const { key } = await uploadFile({ file, grant: (request) => api.requestUpload(request), onProgress });

// 3. server, in the route mounted at `/_storage`: take it back, or refuse
const object = await acceptSignedUpload({
  url: request.url,                  // baseUrl defaults to `disk.signedUrlBase` — the very base
  secret,                            // the driver signed under, `/_storage/<disk name>`. Pass one
  disk: disk('uploads'),             // only for a route mounted somewhere else.
  orgId: ctx.actor.orgId,
  bytes, declaredContentType: request.headers.get('content-type') ?? undefined,
  policy: uploadPolicy({ maxBytes: 5e6 }),
});
```

`acceptSignedUpload` refuses on any of: a signature that does not verify, an expired grant, a
`PUT` grant replayed as a `GET`, a key outside the actor's org, more bytes than the signature
granted, a `Content-Type` the signature does not cover, or magic bytes that contradict it.
`readSignedObject` is the GET half and applies the same verification and the same org check —
which is the `isTenantScoped`/`isWithinOrg` pair, so an app's own un-scoped `brand/logo.png` is
readable through a URL it signed and `org/org-2/…` still is not.
`uploadPolicy({ requireChecksum: true })` needs the request's declared hash, which travels as
`checksum` exactly as the content type travels as `declaredContentType`: a header the route reads
and hands over, hashed again here and refused on any disagreement.
Neither owns a `Request`, a `Response` or a status number — mounting is the host's job, and
`@ultimat3/http` is the only layer that turns an `X_*` code into a status.

**Step 3 ships.** `As of 2026-09-24` `@ultimat3/cli` mounts `PUT /_storage/:disk/*key` beside the
`GET` in `x dev` and `runRole` (#523), so an app writes steps 1 and 2 only. The route calls
`signedUploadConstraints({ url, disk, orgId })` first. That is the verified PUT constraints with
no bytes, and the signed `maxBytes` caps the body read. Then it calls `acceptSignedUpload` with a
policy built from the grant's own signed type and ceiling. The routes serve `definedStorage()`,
the process's one registry, which is the app's `defineStorage` when it declared one (#524).

## Attachments and orphans

An upload happens **before** the row it belongs to exists, so it lands at
`org/<orgId>/pending/<uploadId><ext>` and is promoted once there is an id:

| Call | Key |
|---|---|
| `pendingKey(orgId, uploadName(id, filename))` | `org/o1/pending/u-1.png` |
| `quarantineKey(orgId, name)` | `org/o1/pending/quarantine/u-1.png` |
| `attachmentKey(orgId, { entity, id, field }, name)` | `org/o1/post/p-1/cover/u-1.png` |
| `promoteAttachment({ disk, key, orgId, target, policy })` | `stat`, `copy`, then `delete` — never the reverse. **`policy` is required**: the object is measured here (`stat().size` over `policy.maxBytes` is `X_STORAGE_TOO_LARGE`, and it stays under `pending/` for the sweep), because an s3 presign bounds no size. A retry after the source is gone answers the already-attached object instead of `X_STORAGE_NOT_FOUND`. The key must be a **pending** one (`isPendingKey`): an attached key a client sent back is another row's file, and moving it would delete the victim's copy (`X_STORAGE_NOT_PENDING`) |
| `releaseQuarantine({ disk, key, orgId })` | quarantine → pending; returns the released key |
| `sweepOrphans({ disk, orgId, olderThanMs })` | `{ deleted, failed }` for stale `pending/` keys. `olderThanMs` is a whole number of 0 or more, refused otherwise (`X_INVARIANT`) — `NaN` read as "everything is old enough" and deleted an upload made a moment ago |

The filename contributes nothing but its extension, and only if it matches `.[a-z0-9]{1,12}`.
`sweepOrphans` can only reach the `pending/` prefix of one org — a sweep that could touch an
attached key is a job that deletes production data the first time an app forgets to promote.

**Two lists, because one cannot be wrong.** `sweepOrphans` answers `{ deleted, failed }`: a
refused delete goes in `failed` with the disk's own words and the sweep keeps going. A single
array of "deleted" keys put every refusal in it, so an erasure sweep over a bucket whose policy
had lost `s3:DeleteObject` reported 200 objects gone that were all still there.

### Quarantine is the mechanism; the scanner is your app's

Magic-byte sniffing closes stored XSS. It is **not** malware scanning, and `application/zip` is
accepted on purpose as the OOXML container, so a macro-laden `.docx` passes `validateUpload`
exactly as a clean one does. A scanner is a business decision with a vendor, a licence and a
latency budget (axiom 8), so what ships is the place to put one — one more segment in a
convention that already existed:

```ts
const grant = await grantUpload({ disk, orgId, request, quarantine: true });
// → org/<orgId>/pending/quarantine/<uploadId><ext>

// promoteAttachment on that key throws X_STORAGE_QUARANTINED. Your scan job decides:
const released = await releaseQuarantine({ disk, key, orgId });   // clean
await promoteAttachment({ disk, key: released, orgId, target });
```

Inside `pending/` deliberately: an upload nobody ever scanned is still an orphan, so
`sweepOrphans` collects it with no second prefix to walk.

## Errors

| Code | Fires when |
|---|---|
| `X_STORAGE_DISK_UNKNOWN` | `disk(name)` is not in `storage.disks`; cause lists the real ones |
| `X_STORAGE_NOT_FOUND` | `get`/`stream` on a key that does not exist |
| `X_STORAGE_PATH_UNSAFE` | traversal, absolute key, backslash, NUL, `%2e`, empty segment |
| `X_STORAGE_TOO_LARGE` | payload over the policy `maxBytes` (at validation, or measured by `promoteAttachment`), or over a disk's `maxPutBytes` / `maxGetBytes` |
| `X_STORAGE_TYPE_REJECTED` | declared type off the allowlist, or contradicted by magic bytes |
| `X_STORAGE_CHECKSUM_MISMATCH` | supplied base64 SHA-256 does not describe the bytes |
| `X_STORAGE_URL_INVALID` | a signed request that does not match what was signed — edited constraint, wrong base, wrong method, contradicting `Content-Type` |
| `X_STORAGE_URL_EXPIRED` | the grant's window closed; the signature was fine |
| `X_STORAGE_ORG_MISMATCH` | the key is well-formed and unforged, and belongs to another org |
| `X_STORAGE_UPLOAD_FAILED` | client half: the presigned `PUT` answered non-2xx or never landed |
| `X_STORAGE_DELETE_FAILED` | the disk REFUSED a delete — denied `s3:DeleteObject`, a throttle, an expired credential, a read-only mount. An **absent** key is still not an error |
| `X_STORAGE_LIST_FAILED` | the disk REFUSED a listing — denied `s3:ListBucket`, a throttle, an unreadable root. An **empty** disk is still not an error |
| `X_STORAGE_QUARANTINED` | `promoteAttachment` on a key nothing has released from `pending/quarantine/` |
| `X_STORAGE_NOT_PENDING` | `promoteAttachment` on a key outside the org's `pending/` prefix — most often another row's attached key |
| `X_STORAGE_PUT_FAILED` | the disk REFUSED a `put()`/`copy()` — `EACCES`, `ENOSPC`, `EROFS`, a provider's refused PUT |
| `X_STORAGE_OBJECT_LOCKED` | local, memory: a delete, overwrite or copy onto a key under retention or a legal hold; the cause names the key, the mode and `retainUntil` or the hold, and the bytes are unchanged. Never raised by s3, where the provider keeps the locked version |
| `X_STORAGE_READ_FAILED` | the disk REFUSED a `get`/`stat`/`exists`/`stream` or the read half of a `copy` — a denied `s3:GetObject`, a throttle, an unreadable file. An **absent** object is still `X_STORAGE_NOT_FOUND`, including one deleted between the existence check and the read |
| `X_STORAGE_KEY_CONFLICT` | local and memory disks (never s3): the key's path is another key's directory, or the reverse (`a` and `a/b`) |
| `X_NOT_IMPLEMENTED` | `serverSideEncryption` on any driver |
| `X_ENV_MISSING` | core's: S3 credential env vars, or a `localDriver` built outside development where neither `signingSecret` nor `STORAGE_SIGNING_SECRET` holds a secret other than the published `DEV_SIGNING_SECRET` |
| `X_IMAGE_UNSUPPORTED` | core's: an `avif` encode, a source no built-in decoder reads, or a `variantKey` format no variant can carry |
| `X_IMAGE_DECODE_FAILED` | core's: truncated or corrupt image bytes |

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `StorageError` | any `StorageErrorCode` — `STORAGE_ERROR_CODES` | `src/errors.ts` |

## Images

`variantKey()`, `srcsetDescriptors()`, `fitDimensions()` are pure — `@ultimat3/seo` builds
`srcset` from them without decoding a byte.

A variant key is the WHOLE source key plus the transform: `photos/hero.png` at width 640 is
`photos/hero.png@w640.webp`. The source extension stays in, so `hero.png` and `hero.jpg` are two
cache identities — it was cut, and both minted `photos/hero@w640.webp`. `width` and `height` are
whole numbers of at least 1 on `variantKey` and `fitDimensions` (`X_INVARIANT` otherwise — no
`wNaN`, no `w1.5`). `fitDimensions` never answers a zero edge (1000×1 at width 100 is 100×1) and
never upscales except under `fit: 'cover'`, which is the exact box asked for.

**`VARIANT_FORMATS` / `VariantFormat` are what a variant KEY can carry, `As of 2026-08`** —
`avif`, `webp`, `jpeg`, `png` — and this package exports no `IMAGE_FORMATS` and no `ImageFormat`. Those two names are
`@ultimat3/core`'s, over the six formats it can PROBE (`png`, `jpeg`, `webp`, `avif`, `gif`,
`svg`). Until 9.0.0 both packages exported both names over different sets, so a caller narrowing on
storage's held a type saying `gif` and `svg` could not occur and a `probeImage()` value that was
one. `isVariantFormat(format)` takes a `string`, so a probed format narrows through it with no
cast, and `variantKey()` refuses anything else with core's `X_IMAGE_UNSUPPORTED` instead of minting
`photos/hero@full.undefined`.

`transformImage()` and `blurPlaceholder()` are real, over `@ultimat3/core`'s pipeline, which is
`Bun.Image` — no `sharp`, no dependency. **It encodes `png`, `jpeg` and `webp`** — so the default
format and the default `.webp` key extension finally agree, and a `srcset` entry can be served
rather than only named. `avif` remains key and `srcset` math: it needs an OS codec the portable
backend never uses, so asking for its bytes rejects with core's `X_IMAGE_UNSUPPORTED` naming the
three that work; produce it through a CDN or a custom `ImageTransformDriver`. `png` and `webp` are
the outputs that keep alpha. The encoded size is always exactly `fitDimensions()`, so the
`width`/`height` `@ultimat3/seo` already wrote into the tag match the bytes — `contain` fits inside
the box, it does not letterbox to it. `blurPlaceholder()` returns a ThumbHash PNG `data:` URI, at
most 32px on its long edge.
`bun test` from `packages/storage`.
