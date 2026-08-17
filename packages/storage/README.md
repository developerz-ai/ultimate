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
});

await disk('media').put(scopedKey(orgId, 'avatars', 'a.png'), bytes, { contentType: 'image/png' });
```

Swapping `local` for `s3` in `app.config.ts` changes no call site. `x dev` needs no MinIO.

## Drivers

| Driver | Backing | For | Signed URLs |
|---|---|---|---|
| `localDriver` | `Bun.file`/`Bun.write`, one root dir | dev, tests, single-node | HMAC + dev route |
| `s3Driver` | `Bun.s3` | prod: MinIO, R2, AWS | provider presign |

`copy(from, to)` is on the contract so a promotion is not a download-and-reupload:
`promoteAttachment` used to `get()` the whole object into the app and `put()` it back, a gigabyte
through the pod to rename a 500MB attachment. `localDriver` does a real file copy; `s3Driver`
hands the source `S3File` to `write()` — Bun exposes no `CopyObject`, so the bytes still cross the
network, but never this process's heap. Both arguments go through `assertSafeKey`.

One S3 driver covers all three backends — the difference is `endpoint` + `forcePathStyle`.
Credentials are **env var NAMES** (`accessKeyIdEnv`, default `S3_ACCESS_KEY_ID`), never
literals: a key in `app.config.ts` is a key in git. Missing ones throw `X_ENV_MISSING`.
`localDriver` keeps content type, etag, `cacheControl` and `metadata` in a `<root>/.meta/`
sidecar so `get()`/`list()` round-trip everything `put()` was handed; sidecars never appear in
`list()`. `s3Driver` cannot: it refuses `cacheControl`/`metadata` on `put()` (`X_NOT_IMPLEMENTED`,
Bun exposes no header hook yet).

**`StorageListEntry.contentType` is optional; `StorageObject.contentType` is not.** S3's
`ListObjectsV2` returns no Content-Type, so a listed s3 object simply has none — reading the real
value would cost one `HeadObject` per row, which is what `list()` exists to avoid. It used to
report `application/octet-stream`, indistinguishable from an object that really is one, while the
local driver read the truth out of its sidecar: a caller filtering a listing by content type got
everything on `local` and nothing on `s3`. `get()` always answers a full `StorageObject`.

The etag follows the same rule: a listed object with no sidecar reports `etag: ''`, because
answering otherwise means reading and hashing the whole object — which is what the local `list()`
used to do, once per sidecar-less row, sequentially. `get()` hashes out of bytes it already holds.

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
client-supplied key with `isWithinOrg(key, ctx.actor.orgId)`. A surface that serves objects pairs
it with `isTenantScoped(key)`: only a key already inside `org/` is another tenant's to refuse, so
`disk().put('brand/logo.png', …)` stays reachable while `org/org-2/…` never is.

## Signed URLs

The HMAC covers the **constraints**, not just the key —
`v1 \n METHOD \n key \n expiresAt \n maxBytes \n contentType`.
A client that edits `?x-max=` invalidates the signature — it cannot widen what it was granted.

The HMAC key is `signingSecret`, else `STORAGE_SIGNING_SECRET`, else the shipped
`DEV_SIGNING_SECRET` — and **only in `development` or `test`**. Anywhere else `localDriver` refuses
to construct (`X_ENV_MISSING`) unless one of those two is set to something that is not the shipped
literal: the dev literal is published in this repo, so signing with it lets anyone mint a `PUT` for
any key with a `maxBytes` and `contentType` of their choosing, which `acceptSignedUpload` then
trusts over the app's own `uploadPolicy`. Setting `STORAGE_SIGNING_SECRET=$DEV_SIGNING_SECRET`, or
pasting the literal into `signingSecret`, is refused exactly as an unset variable is. `usesDevStorageSecret()` is the
`x doctor` probe for it, the twin of core's `usesDevCursorSecret()`.
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
bytes (PNG, JPEG, GIF, WebP, PDF, ZIP/OOXML, SVG, MP4, HTML, plain text) and rejects any
payload whose bytes contradict the declaration. Checks run cheapest-first: key → size →
allowlist → sniff → checksum.

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
  url: request.url, secret, baseUrl: '/_storage/local',
  disk: disk('uploads'), orgId: ctx.actor.orgId,
  bytes, declaredContentType: request.headers.get('content-type') ?? undefined,
  policy: uploadPolicy({ maxBytes: 5e6 }),
});
```

`acceptSignedUpload` refuses on any of: a signature that does not verify, an expired grant, a
`PUT` grant replayed as a `GET`, a key outside the actor's org, more bytes than the signature
granted, a `Content-Type` the signature does not cover, or magic bytes that contradict it.
`readSignedObject` is the GET half and applies the same verification and the same org check.
Neither owns a `Request`, a `Response` or a status number — mounting is the host's job, and
`@ultimat3/http` is the only layer that turns an `X_*` code into a status.

## Attachments and orphans

An upload happens **before** the row it belongs to exists, so it lands at
`org/<orgId>/pending/<uploadId><ext>` and is promoted once there is an id:

| Call | Key |
|---|---|
| `pendingKey(orgId, uploadName(id, filename))` | `org/o1/pending/u-1.png` |
| `quarantineKey(orgId, name)` | `org/o1/pending/quarantine/u-1.png` |
| `attachmentKey(orgId, { entity, id, field }, name)` | `org/o1/post/p-1/cover/u-1.png` |
| `promoteAttachment({ disk, key, orgId, target })` | `copy` then `delete` — never the reverse |
| `releaseQuarantine({ disk, key, orgId })` | quarantine → pending; returns the released key |
| `sweepOrphans({ disk, orgId, olderThanMs })` | `{ deleted, failed }` for stale `pending/` keys |

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
| `X_STORAGE_TOO_LARGE` | payload over the policy `maxBytes`, or over a disk's `maxPutBytes` |
| `X_STORAGE_TYPE_REJECTED` | declared type off the allowlist, or contradicted by magic bytes |
| `X_STORAGE_CHECKSUM_MISMATCH` | supplied base64 SHA-256 does not describe the bytes |
| `X_STORAGE_URL_INVALID` | a signed request that does not match what was signed — edited constraint, wrong base, wrong method, contradicting `Content-Type` |
| `X_STORAGE_URL_EXPIRED` | the grant's window closed; the signature was fine |
| `X_STORAGE_ORG_MISMATCH` | the key is well-formed and unforged, and belongs to another org |
| `X_STORAGE_UPLOAD_FAILED` | client half: the presigned `PUT` answered non-2xx or never landed |
| `X_STORAGE_DELETE_FAILED` | the disk REFUSED a delete — denied `s3:DeleteObject`, a throttle, an expired credential, a read-only mount. An **absent** key is still not an error |
| `X_STORAGE_LIST_FAILED` | the disk REFUSED a listing — denied `s3:ListBucket`, a throttle, an unreadable root. An **empty** disk is still not an error |
| `X_STORAGE_QUARANTINED` | `promoteAttachment` on a key nothing has released from `pending/quarantine/` |
| `X_NOT_IMPLEMENTED` | S3 user metadata / cache-control; `serverSideEncryption` on either driver |
| `X_ENV_MISSING` | core's: S3 credential env vars, or a `localDriver` built outside development where neither `signingSecret` nor `STORAGE_SIGNING_SECRET` holds a secret other than the published `DEV_SIGNING_SECRET` |
| `X_IMAGE_UNSUPPORTED` | core's: an `avif`/`webp` encode, or a source no built-in decoder reads |
| `X_IMAGE_DECODE_FAILED` | core's: truncated or corrupt image bytes |

## Images

`variantKey()`, `srcsetDescriptors()`, `fitDimensions()` are pure — `@ultimat3/seo` builds
`srcset` from them without decoding a byte.

`transformImage()` and `blurPlaceholder()` are real, over `@ultimat3/core`'s zero-dependency
pipeline. **It encodes `png` and `jpeg`, nothing else** — `avif`/`webp` remain key and `srcset`
math, and asking for their bytes rejects with core's `X_IMAGE_UNSUPPORTED` naming the two that
work; produce them through a CDN or a custom `ImageTransformDriver`. `png` is the only output
that keeps alpha. The encoded size is always exactly `fitDimensions()`, so the `width`/`height`
`@ultimat3/seo` already wrote into the tag match the bytes — `contain` fits inside the box, it
does not letterbox to it. `blurPlaceholder()` returns a real 16px-wide PNG `data:` URI.
`bun test` from `packages/storage`.
