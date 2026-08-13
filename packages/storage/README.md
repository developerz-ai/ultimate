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

One S3 driver covers all three backends — the difference is `endpoint` + `forcePathStyle`.
Credentials are **env var NAMES** (`accessKeyIdEnv`, default `S3_ACCESS_KEY_ID`), never
literals: a key in `app.config.ts` is a key in git. Missing ones throw `X_ENV_MISSING`.
`localDriver` keeps content type, etag, `cacheControl` and `metadata` in a `<root>/.meta/`
sidecar so `get()`/`list()` round-trip everything `put()` was handed; sidecars never appear in
`list()`. `s3Driver` cannot: it refuses `cacheControl`/`metadata` on `put()` (`X_NOT_IMPLEMENTED`,
Bun exposes no header hook yet), and its `list()` always reports `DEFAULT_CONTENT_TYPE` — S3's
`ListObjectsV2` does not return Content-Type, and reading it for real would cost one `HeadObject`
per listed row.

## Keys

`assertSafeKey()` runs on every key before it reaches a driver. Rejected: `..` segments,
absolute keys, backslashes, NUL/control bytes, percent-encoded separators (`%2e`, `%2f`),
empty segments, over 1024 chars. No sanitising — a key that needed fixing was built wrong.
`scopedKey('org-1', 'avatars', 'a.png')` is `org/org-1/avatars/a.png`; guard every
client-supplied key with `isWithinOrg(key, ctx.actor.orgId)`. A surface that serves objects pairs
it with `isTenantScoped(key)`: only a key already inside `org/` is another tenant's to refuse, so
`disk().put('brand/logo.png', …)` stays reachable while `org/org-2/…` never is.

## Signed URLs

The HMAC covers the **constraints**, not just the key —
`v1 \n METHOD \n key \n expiresAt \n maxBytes \n contentType`.
A client that edits `?x-max=` invalidates the signature — it cannot widen what it was granted.
Verification is constant-time, checks the signature *before* the expiry (a forged URL never
learns it was merely late), takes a `Clock` so tests freeze time, and returns
`{ ok: false, reason }` rather than throwing — `malformed | unsafe-key | signature-mismatch |
expired`. S3 presign covers method, expiry and content type but **not** `maxBytes`: S3 has no
header for it, so size stays a server-side `validateUpload()` check.

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
| `attachmentKey(orgId, { entity, id, field }, name)` | `org/o1/post/p-1/cover/u-1.png` |
| `promoteAttachment({ disk, key, orgId, target })` | copy then delete — never the reverse |
| `sweepOrphans({ disk, orgId, olderThanMs })` | deletes stale `pending/` keys, returns them |

The filename contributes nothing but its extension, and only if it matches `.[a-z0-9]{1,12}`.
`sweepOrphans` can only reach the `pending/` prefix of one org — a sweep that could touch an
attached key is a job that deletes production data the first time an app forgets to promote.

## Errors

| Code | Fires when |
|---|---|
| `X_STORAGE_DISK_UNKNOWN` | `disk(name)` is not in `storage.disks`; cause lists the real ones |
| `X_STORAGE_NOT_FOUND` | `get`/`stream` on a key that does not exist |
| `X_STORAGE_PATH_UNSAFE` | traversal, absolute key, backslash, NUL, `%2e`, empty segment |
| `X_STORAGE_TOO_LARGE` | payload over the policy `maxBytes` |
| `X_STORAGE_TYPE_REJECTED` | declared type off the allowlist, or contradicted by magic bytes |
| `X_STORAGE_CHECKSUM_MISMATCH` | supplied base64 SHA-256 does not describe the bytes |
| `X_STORAGE_URL_INVALID` | a signed request that does not match what was signed — edited constraint, wrong base, wrong method, contradicting `Content-Type` |
| `X_STORAGE_URL_EXPIRED` | the grant's window closed; the signature was fine |
| `X_STORAGE_ORG_MISMATCH` | the key is well-formed and unforged, and belongs to another org |
| `X_STORAGE_UPLOAD_FAILED` | client half: the presigned `PUT` answered non-2xx or never landed |
| `X_NOT_IMPLEMENTED` | S3 user metadata |
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
